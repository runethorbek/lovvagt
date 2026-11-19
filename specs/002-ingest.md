# Spec 002 – Ingest bills from ODA

**Status:** Ready for implementation (epic #32)
**Owner:** Rune (human)
**Implementer:** Claude Code (agent), via epic and sub-issues

## Goal

Get the raw material for the rest of the pipeline into our own storage:
metadata for candidate bills (Lovforslag) on AI, security and defence,
their stages, votes and documents in Postgres, and the bill texts
themselves in Blob.

After this spec is implemented:

1. One protected call, `POST /api/ingest`, fetches everything new or
   changed in ODA since the last run and stores it. Calling it again
   right away changes nothing.
2. The first runs backfill every candidate bill from session 2024-25
   onwards, spread over as many calls and days as the Vercel function
   limit and the Blob quota require.
3. For every candidate bill the database records **why** it was
   selected (which rule matched), so phase 4 can make the final
   relevance decision and we can tune the rules.

## Context

Phase 1 (spec 001) built the access layers: `lib/config.ts`, `lib/db.ts`,
`lib/blob/` and `lib/model.ts`, and the protected `GET /api/health`. This
spec adds the first schema, a migration tool and the ODA client. Cron
and Workflow come in phase 8. Until then the human or a script calls the
route. The functions must be written as plain steps that a Workflow can
wrap later (ADR 0002, decision 2).

### Folketingets Åbne Data (ODA)

ODA is a public OData v3 API at `https://oda.ft.dk/api`, with no
authentication. Facts checked against the live API on 2026-11-19:

- **Paging:** `$top` is capped at 100. Responses with more rows carry
  `odata.nextLink`. `$inlinecount=allpages` returns `odata.count`.
  Add `$format=json` to every request.
- **Incremental:** every entity has `opdateringsdato` (last updated).
  Timestamps have no offset (e.g. `2026-11-18T14:31:51.75`). Treat them as
  Danish local time (`Europe/Copenhagen`) and store them as `timestamptz`.
  Verify this assumption against a known change and record the result in
  `docs/ingest.md`.
- **Bills:** `Sag` with `typeid eq 3` (Sagstype `Lovforslag`).
  `periodeid` is the parliamentary session (`Periode`, `type` `samling`).
  Sessions from 2024-25 on: 163 (2024-25), 165 (2025-26, 1st session),
  167 (2025-26, 2nd session), 168 (2026-27). Select sessions by
  `type eq 'samling'` and `startdato` on or after `2024-10-01`, not by
  hard-coded IDs, so new sessions are picked up automatically.
  Volume is 150 to 260 bills per session.
- **Stages:** `Sagstrin` (`sagid`), with `Sagstrinstype`.
- **Votes:** `Afstemning` has `sagstrinid`. Reach a bill's votes with
  `$filter=Sagstrin/sagid eq <id>`. Individual votes are `Stemme`
  (`afstemningid`, `aktørid`, `typeid` → `Stemmetype`). Not every bill
  has a recorded vote (e.g. L 211 in 2024-25 has none).
- **Actors on a bill:** `SagAktør` with `SagAktørRolle`. Role 6
  (`Ministerområde`) is the responsible ministry, e.g. `Forsvarsministeriet`.
- **Documents:** `SagDokument` links a `Sag` to a `Dokument`, with a role
  (`SagDokumentRolle`, e.g. `På sagstrin`, `Hovedtilknytning`).
  `Dokumenttype` 21 is `Forslagstekst`: the bill text in its versions
  (as introduced, committee report, after 2nd reading, as adopted).
- **Files:** `Fil` (`dokumentid`) has `filurl`, `format` (`PDF`, `DOCX`),
  `variantkode` and `versionsdato`. **The URL extension is unreliable:**
  DOCX files are served from URLs ending in `.pdf`. Trust `format`, and
  check the downloaded bytes (`%PDF` for PDF, a ZIP header `PK` for DOCX).
- **Subject keywords:** `EmneordSag` / `Emneord` exist but are
  inconsistent. The 2024-25 AI Act bill (L 154) is tagged
  "Biblioteker og museer" and "digital service og digital
  transformation". Use them as one signal among several, never alone.
- **Example:** L 211 (2024-25, `Sag` 101687, drone defence at military
  sites) has 14 stages, 17 documents and 22 files (13 PDF, 9 DOCX). Five
  of its documents are `Forslagstekst`.

### Quotas and limits

- Vercel functions run for at most 300 s by default. One call cannot do
  the whole backfill, so ingest must be resumable.
- Blob on Hobby: 1 GB storage and 2,000 advanced operations (put, copy,
  list) per month. The health check uses one put per call. Ingest must
  never call `list`; the database is the source of truth for what is
  stored.
- Neon is reached over HTTP (`lib/db.ts`), so session-level features such
  as advisory locks do not work across statements.

### Decisions made by the human for this spec (2026-11-19)

1. **Wide net:** a bill is a candidate if any rule matches: responsible
   ministry, keyword in title or summary, or Emneord. Phase 4 makes
   the final relevance call.
2. **Backfill** from session 2024-25.
3. **Files:** download only bill text (`Forslagstekst`) in phase 2.
   Metadata for all documents and files is still stored.
4. **Entrypoint:** protected `POST /api/ingest`, authorised like
   `/api/health`.

## Prerequisites (human, before implementation starts)

- [ ] Review and approve the seed topic rules in deliverable 3.
- [ ] Check current Blob usage for both stores in the Vercel dashboard,
      so the monthly cap in deliverable 6 starts from a known number.

## Out of scope

- Text extraction, sectioning and document version tracking (phase 3).
- LLM relevance classification and summaries (phase 4).
- Event detection and timelines (phase 6).
- Vercel Cron and Workflow (phase 8).
- Dashboard pages.
- Case types other than Lovforslag (e.g. Beslutningsforslag).
- Downloading files other than bill text (consultation responses,
  questions and answers, annexes).
- Handling records deleted in ODA. Record what is observed in
  `docs/ingest.md`.
- Adding ODA to `/api/health`.

## Deliverables

### 1. Schema and migrations

- Plain SQL migration files in `db/migrations/`, named
  `NNNN_short_name.sql` and applied in order. Track applied migrations
  in a `schema_migrations` table (name, checksum, applied time). A
  changed checksum on an applied migration is an error.
- `npm run db:migrate` applies pending migrations through `lib/db.ts`.
  It refuses to run unless `config.environment()` is `development`,
  except with an explicit `--environment=<name>` flag that matches the
  actual environment. The human uses the flag for Preview and
  Production. Agents only migrate the development database (CLAUDE.md).
- No ORM. Prefer no new runtime dependency. If the runner needs a dev
  dependency (e.g. to run TypeScript), state why in the PR.
- ADR 0006 records the migration approach.

Tables mirror ODA. ODA `id` is the primary key, columns are snake_case
ASCII (`aktoer`, `afgoerelse`), and every ODA table keeps the full source
record in a `raw jsonb` column next to the typed columns we use, so
later phases can read fields we did not map:

| Table                    | Source                               |
| ------------------------ | ------------------------------------ |
| `periode`                | `Periode`                            |
| `sag`                    | `Sag` (candidates only)              |
| `sagstrin`               | `Sagstrin` (+ type name)             |
| `afstemning`             | `Afstemning`                         |
| `stemme`                 | `Stemme` (+ type name)               |
| `aktoer`                 | `Aktør` referenced by any stored row |
| `sag_aktoer`             | `SagAktør` (+ role name)             |
| `dokument`               | `Dokument` (+ type name)             |
| `sag_dokument`           | `SagDokument` (+ role name)          |
| `fil`                    | `Fil`                                |
| `emneord`, `emneord_sag` | `Emneord`, `EmneordSag`              |

Lovvagt's own tables:

| Table         | Purpose                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracked_sag` | One row per candidate bill and topic: `sag_id`, `topic`, `matched_rules jsonb`, `first_matched_at`, `last_evaluated_at`, `matching` (bool). |
| `fil_blob`    | One row per stored file version: `fil_id`, `blob_path`, `sha256`, `size_bytes`, `content_type`, `oda_opdateringsdato`, `stored_at`.         |
| `blob_op`     | One row per Blob advanced operation by Lovvagt (`op`, `at`), used for the monthly budget.                                                   |
| `ingest_run`  | One row per call: start, end, status, per-entity counts, watermarks, error (fixed strings only), lease expiry.                              |

### 2. ODA client (`lib/oda/`)

- The only code that talks to ODA. Add a boundary test: no other file
  contains `oda.ft.dk`.
- Typed queries for the entities above, validated with Zod. Unknown
  extra fields are allowed and kept in `raw`.
- Follows `odata.nextLink` until done. Accepts an `AbortSignal`, so the
  caller's time budget can stop it.
- Sequential requests (no parallel requests to ODA), a timeout per
  request, and retries with backoff on network errors, 429 and 5xx.
  Sends a generic `User-Agent` with no personal contact details.
- Downloads a file's bytes for the Blob step (deliverable 6) with a
  maximum size (default 25 MB). Larger files are recorded as skipped,
  not stored.

### 3. Candidate selection (`lib/ingest/topics.ts`)

Topics and rules are a typed config object in code, reviewed in PRs.
For each topic a bill is a candidate if **any** of these matches:

- **Ministry:** the bill's `SagAktør` with role 6 (`Ministerområde`) has
  a listed name.
- **Keyword:** a case-insensitive, word-boundary-aware pattern matches
  `titel`, `titelkort` or `resume`.
- **Emneord:** one of the bill's Emneord is listed.

A topic can also list **exclusions**: keyword patterns that cancel a
match that came only from a keyword. Each match is stored in
`tracked_sag.matched_rules` (rule kind, value, field). Rules are
re-evaluated whenever a bill changes. A bill that stops matching keeps
its rows with `matching = false`.

Seed rules (the human approves them as a prerequisite; the agent
verifies them against real bills and proposes changes in the PR):

| Topic      | Ministries                                                                          | Keywords (stems)                                                                                                                                                      | Exclusions                 |
| ---------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `defence`  | Forsvarsministeriet                                                                 | forsvaret, forsvars- (as a compound prefix), militær, værnepligt, NATO, våben, krigs-, drone                                                                          | forsvarer, forsvarsadvokat |
| `security` | Ministeriet for Samfundssikkerhed og Beredskab                                      | cybersikkerhed, informationssikkerhed, NIS 2, efterretningstjeneste, PET, FE, terror, spionage, kritisk infrastruktur, samfundssikkerhed, beredskab, hybrid, sabotage | –                          |
| `ai`       | Digitaliseringsministeriet; Forsknings-, Uddannelses- og Digitaliseringsministeriet | kunstig intelligens, AI-forordning, forordningen om kunstig intelligens, algoritm-, automatiseret afgørelse, maskinlæring, ansigtsgenkendelse                         | –                          |

Check the exact ministry names in ODA's `Aktør` table (ministry names
change with governments). Include every name each ministry has had
since 2024.

### 4. Ingest steps (`lib/ingest/`)

Plain async functions, each idempotent and resumable, that a Workflow can
later run as durable steps:

1. **Sessions:** upsert `periode` rows for sessions in scope.
2. **Bills:** fetch `Sag` (Lovforslag) changed since the watermark (on
   the first run, all bills in scope), together with their `SagAktør`
   and `EmneordSag`. Evaluate topic rules. Upsert candidates into `sag`
   and `tracked_sag`. Non-candidates are not stored.
3. **Children:** for candidate bills, fetch `Sagstrin`, `Afstemning`,
   `Stemme`, `SagDokument`, `Dokument` and `Fil` that are new or
   changed, and upsert them along with referenced `Aktør` rows. A
   newly tracked bill gets all its children. After that, a run must not
   re-fetch the children of a bill when nothing in ODA has changed.
   Using global "changed since" queries per entity, filtered locally to
   tracked bills, is the expected approach.
4. **Files:** see deliverable 6.

Rules:

- Upserts skip writes when nothing has changed (compare
  `opdateringsdato` or `raw`), so an immediate second run reports zero
  changes.
- Each entity's watermark is the highest `opdateringsdato` stored by the
  last successful step, and the next query starts one hour before it to
  absorb ordering and clock differences.
- Errors are recorded as fixed strings. ODA, database and Blob error
  messages are never passed on (CLAUDE.md).

### 5. Route `POST /api/ingest`

- Authorised exactly like `/api/health` (reuse `isAuthorised`). 401
  with no body otherwise, and nothing runs.
- Always dynamic, no caching. `maxDuration` 300.
- Runs the steps in order within a **time budget** (default 240 s).
  When the budget runs out it stops cleanly after the current unit of
  work, saves progress and returns `"done": false`. The caller calls
  again until `"done": true`.
- One run at a time: take a lease row in `ingest_run` with an expiry.
  Return 409 if another lease is active.
- Responds with JSON: `environment`, `runId`, `done`, per-entity counts
  (fetched, inserted, updated, unchanged), `files` (stored, unchanged,
  deferred, skipped), and the Blob operations used this month.
  Status 200 when the run completed or stopped on budget, 500 with a
  fixed error string when a step failed.
- `scripts/ingest-until-done.sh` (or similar) calls the route in a loop
  until `done` for local and manual backfills. It reads the secret from
  the environment and never prints it.

### 6. Bill text files to Blob

- For each candidate bill's `Forslagstekst` documents, pick one file per
  document: DOCX if available, otherwise PDF.
- Store it through `lib/blob/` at
  `oda/fil/<filId>/<sha256>.<pdf|docx>`, and record it in `fil_blob`. Do not
  upload again if a row with the same `fil_id` and `sha256` exists. If
  `Fil.opdateringsdato` changes, download again and store a new version
  only when the hash differs.
- Verify the bytes match `format` before storing. On a mismatch, record
  the file as skipped with a reason.
- **Budget:** before every put, check the number of `blob_op` rows in
  the current calendar month (UTC) against a cap from config (default
  1,500, leaving room for health checks and phase 3). When the cap is
  reached, stop downloading, mark files as deferred and let metadata
  ingest continue. Deferred files are picked up by later runs and later
  months.
- Also stop at a storage cap (default 800 MB, the sum of `size_bytes`).

### 7. Tests

- Unit tests with recorded ODA fixtures in `tests/fixtures/oda/`
  (trimmed real responses, including the L 211 and L 154 records and a
  paged response with `odata.nextLink`). CI never calls ODA, Neon or
  Blob.
- Topic rules: the known positives and negatives in the acceptance
  criteria, as table-driven tests on fixture records.
- Repository and upsert SQL tested against a real Postgres engine
  without network access (e.g. PGlite as a dev dependency; state why
  in the PR), including "a second upsert of the same data writes
  nothing".
- Migration runner: order, checksum mismatch, environment refusal.
- Route: 401 without or with a wrong secret, 409 while a lease is
  active, `done: false` when the budget runs out (fake clock), and no
  environment variable value in any response body.
- Blob budget: stops at the cap and marks the remaining files as
  deferred.
- E2E: `POST /api/ingest` without authorisation returns 401.

### 8. Documentation

- `docs/ingest.md`: what is fetched and stored, how to run a backfill
  locally and in production, the quotas and how the caps work, ODA quirks
  (including results of the timestamp check), and SQL to inspect a bill
  and why it was selected.
- ADR 0006 (migrations).
- `CLAUDE.md`: ODA only through `lib/oda/`, `npm run db:migrate` in the
  commands table, and the migration rule.
- `.env.example`: any new variables (e.g. the caps), with defaults in
  `lib/config.ts`.

## Acceptance criteria

- [ ] All npm scripts pass, and CI is green.
- [ ] No file outside `lib/oda/` contains `oda.ft.dk` (boundary test).
- [ ] `npm run db:migrate` on the development database creates the
      schema. Running it again applies nothing. Without the flag it
      refuses to run when the environment is not `development`.
- [ ] `POST /api/ingest` without the secret returns 401 locally and in
      Production, and creates no `ingest_run` row.
- [ ] Locally, repeated calls until `done: true` backfill the development
      database. Every candidate bill in sessions from 2024-25 is present,
      with stages, votes, documents and files that match ODA at the time
      of checking.
- [ ] These bills are tracked with the expected topic: 2024-25 L 154
      (`ai`), L 152 (`ai`), L 141 (`security`), L 211 (`defence`),
      L 188 (`defence`), L 210 (`defence`). 2024-25 L 31
      (forsvarerbistand) is **not** tracked.
- [ ] For L 211, the bill text files (`Forslagstekst`) are in the
      development Blob store, and their `sha256` matches a fresh download.
- [ ] A second call right after a completed backfill reports zero
      inserted or updated rows and zero Blob operations.
- [ ] With the monthly cap set to a small number, ingest stores exactly
      that many files, marks the rest as deferred, and still completes
      metadata ingest.
- [ ] No run exceeds the function time limit. Vercel logs show no timeouts
      in Production.
- [ ] The human migrates Production and runs the backfill there. The
      candidate counts per topic match Development (within the changes
      ODA made between the two runs).

The last two criteria, and the Production half of the 401 criterion,
are verified by the human after deployment.

## How to work on this spec

1. **Breakdown first.** Read this spec and `CLAUDE.md`. Create one epic
   issue linking to this spec, and sub-issues using the task template,
   each with acceptance criteria and dependencies. Suggested split:
   migrations and schema (+ ADR 0006), ODA client, topic rules,
   ingest steps for bills and children, Blob file step with budget,
   route and backfill script, documentation. Adjust if you see a
   better split and explain why in the epic.
2. Label the epic `type:epic` and sub-issues `type:task` plus an area
   label. **Do not** add `agent:ready`. Stop and report the breakdown for
   human approval.
3. After approval, the human sets `agent:ready` on issues whose
   dependencies are met. Implement one issue at a time, following the
   workflow rules in `CLAUDE.md`.
