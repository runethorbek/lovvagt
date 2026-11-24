# Ingest

`POST /api/ingest` fetches candidate bills (Lovforslag) on AI, security
and defence from Folketingets Åbne Data (ODA) and stores them in Postgres
(spec 002). It is implemented in `app/api/ingest/route.ts` (the route),
`lib/ingest/run.ts` (one call: lease, budget, progress), `lib/ingest/steps.ts`
(the steps), `lib/ingest/repository.ts` (the SQL), `lib/ingest/topics.ts`
(the topic rules) and `lib/oda/` (the only code that talks to ODA).

## What is fetched and stored

Each call runs the steps in this order, continuing where the previous call
stopped:

| Step       | Fetches                                                                                                                                            | Stores                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `sessions` | `Periode` with `type eq 'samling'` starting on or after 2024-10-01 (in full, one request)                                                          | `periode`                                                                                                            |
| `bills`    | `Sag` with `typeid eq 3` in those sessions, changed since the `sag` watermark (all of them on a first run), with their `SagAktør` and `EmneordSag` | Candidates only: `sag`, `tracked_sag` (one row per bill and topic), `sag_aktoer`, `aktoer`, `emneord`, `emneord_sag` |
| `links`    | `SagAktør`, `EmneordSag`, `Aktør` and `Emneord` changed since their watermarks; re-evaluates the bills they affect                                 | As `bills`                                                                                                           |
| `children` | For tracked bills: `Sagstrin`, `Afstemning`, `Stemme`, `SagDokument`, `Dokument`, `Fil` (new bills in full, then changed-since queries per entity) | `sagstrin`, `afstemning`, `stemme`, `sag_dokument`, `dokument`, `fil`, referenced `aktoer`                           |
| `files`    | Not built yet (#38): bill texts (`Forslagstekst`) to Blob                                                                                          | `fil_blob`, `blob_op`                                                                                                |

Every ODA table keeps the full source record in `raw`. Upserts skip rows
that have not changed, so a call right after a completed run writes
nothing. A bill is a candidate if any topic rule matches (ministry, keyword
in `titel`/`titelkort`/`resume`, or Emneord); which rules matched is stored
in `tracked_sag.matched_rules`. A bill that stops matching keeps its rows
with `matching = false`, and its children keep being ingested.

Rows deleted in ODA are not removed (out of scope in spec 002).

## The route

`POST /api/ingest` requires `Authorization: Bearer <CRON_SECRET>`, checked
like `/api/health` (`isAuthorised` in `lib/health.ts`). Without a valid
header it returns **401** with an empty body, before touching the database:
nothing runs and no `ingest_run` row is created. Only `POST` is exported;
`GET` returns 405. The route is always dynamic (`Cache-Control: no-store`)
and has `maxDuration` 300.

```json
{
  "environment": "development",
  "runId": 12,
  "done": false,
  "counts": {
    "periode": { "fetched": 4, "inserted": 0, "updated": 0, "unchanged": 4 },
    "sag": { "fetched": 100, "inserted": 18, "updated": 0, "unchanged": 0 },
    "…": "one entry per entity: periode, sag, sag_aktoer, aktoer, emneord, emneord_sag, tracked_sag, sagstrin, afstemning, stemme, sag_dokument, dokument, fil"
  },
  "files": { "stored": 0, "unchanged": 0, "deferred": 0, "skipped": 0 },
  "blobOperationsThisMonth": 3
}
```

- `counts` cover this call only. `files` is all zeros until the file step
  (#38) exists. `blobOperationsThisMonth` counts `blob_op` rows in the
  current UTC calendar month (`null` if it could not be read).
- **200** when the run completed (`done: true`) or the call stopped on its
  time budget (`done: false`: call again).
- **409** with `"error": "another ingest run is in progress"` while another
  call holds the lease.
- **500** with a fixed `error` when a step failed (`"ODA request failed"`,
  `"database query failed"`, `"ingest failed"`) or the database is not
  configured (`"configuration missing or invalid"`). Driver, ODA and SDK
  messages are never passed on, and no response contains an environment
  variable value (unit-tested).

### Lease

Each call inserts one `ingest_run` row with status `running`; that row is
the lease. A partial unique index allows only one running row. In one
transaction the call marks a running row whose `lease_expires_at` has
passed as `expired` (error `"lease expired"`) and inserts its own; a unique
violation (SQLSTATE 23505) means a live lease: 409. The lease lasts 600 s,
twice the function's maximum duration, so a live call is never taken over.
A call that crashed leaves a `running` row that blocks new calls for up to
10 minutes. Its final status is `completed`, `stopped`, `failed` or
`expired`.

### Time budget

No step or unit of work starts after 240 s (`defaultBudgetMs`). At 270 s
(`defaultAbortAfterMs`) a running ODA request is aborted; the unit it
belonged to wrote nothing and is redone by the next call. The remaining
30 s are for saving progress. Worst cases to keep in mind:

- A query can take 4 attempts × 30 s, plus backoff of up to 15 s between
  attempts. A unit with several queries can therefore outlast the budget;
  the abort signal is what keeps the call within 300 s.
- A file download (the file step, #38) takes up to 120 s per attempt.
- Known limitation: a caller that aborts while waiting for the ODA client's
  request lock is released only when the current attempt ends. Requests
  within one call are sequential, so this matters only if two callers
  share a process.

### Progress across calls

A backfill spans many calls, each with its own `ingest_run` row. The column
`ingest_run.progress` (migration `0002_ingest_run_progress`) holds where the
run continues: the next step, that step's cursor, the watermarks the run
started from and those produced by its finished steps. It is saved when a
call starts, after each finished step and when the call ends.

A call continues from the latest earlier row that is `completed` or has
`progress`. After a `completed` row it starts a new run; after a `stopped`,
`failed` or `expired` row it continues that row's progress. A row without
progress (a call that failed before saving any) is skipped.

When a step fails, the row is marked `failed` with the progress from before
that step's call, and the next call redoes the step from the cursor it
started with. Upserts are idempotent, so this is safe. A step that fails
every time (for example ODA down for hours) keeps failing until the cause
is gone; nothing is lost in between. To abandon an unfinished run and start
over from the stored watermarks, clear its progress:
`UPDATE ingest_run SET progress = NULL WHERE status <> 'running';`.

### Watermarks

Each entity's watermark is the highest `opdateringsdato` a finished step
fetched, capped at the step's start and never moved back; the next query
starts one hour before it. `tracked_sag` is the database clock at the start
of the children step. `readWatermarks` takes each entity's value from the
latest `ingest_run` row that has it, whatever its status.

So that a partial run is never trusted:

- Every call of a run starts its steps from the watermarks stored **before**
  the run began (`progress.since`), carried across all its calls. In
  particular the links step's `initialSince` is the pre-run `sag`
  watermark; only on a first run (none stored) is it the watermark the
  bills step produced.
- Watermarks produced by finished steps stay in `progress` and are written
  to `ingest_run.watermarks` only by the call that completes the run.
  `stopped`, `failed` and `expired` rows have empty watermarks.

`scripts/ingest-steps.ts` (development only) runs the same steps in one
process without a lease and records a `completed` row. Do not run it while
the route runs.

## Running a backfill

`scripts/ingest-until-done.ts` calls the route until `done: true`. It
prints one line per call and the full response of the last call, reads
`CRON_SECRET` through `lib/config.ts` and never prints it. It exits
non-zero on 401, 409, 500, a response that is not JSON, a network error or
after 200 calls.

### Locally (development database)

Migrate the development database first (`npm run db:migrate`), then:

```sh
npm run dev
# in another terminal
npx tsx --env-file-if-exists=.env.local scripts/ingest-until-done.ts http://localhost:3000
```

`.env.local` (from `vercel env pull`) holds the Development values,
including `CRON_SECRET` and `DATABASE_URL`.

### Production (human only)

The human migrates Production (`npm run db:migrate -- --environment=production`
with Production credentials) and then runs the script against the
Production URL, with the Production `CRON_SECRET` in the environment
rather than on the command line:

```sh
read -rs CRON_SECRET && export CRON_SECRET
npx tsx scripts/ingest-until-done.ts https://<production-host>
```

An environment variable that is already set takes precedence over
`.env.local`. Preview deployments sit behind deployment protection; call
them with the Vercel CLI instead, which gets past it:

```sh
vercel curl <preview-url>/api/ingest -- -X POST -H "Authorization: Bearer $CRON_SECRET"
```

Repeat until the response says `"done": true`.

## Quotas and caps

| Limit                     | Value                                                     | How it is handled                                                                          |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ODA page size             | `$top` at most 100; longer results carry `odata.nextLink` | Steps work in units of one page; the client follows `nextLink`                             |
| Function duration         | 300 s (`maxDuration`)                                     | Budget 240 s, abort at 270 s, then save progress                                           |
| Blob storage (Hobby)      | 1 GB                                                      | Planned cap 800 MB of `fil_blob.size_bytes` (enforced once #38 lands)                      |
| Blob advanced ops (Hobby) | 2,000 per month (put, copy, list)                         | Planned cap 1,500 `blob_op` rows per UTC month (once #38 lands); ingest never calls `list` |

## ODA quirks found in this epic

- **Timestamps** carry no offset. They are Copenhagen local time: checked
  against a known change on the live API on 2026-11-20 (#34), in winter
  time. Summer time is not yet verified; re-check after 2027-03-28.
- **Bill files** (`Fil.filurl` on `www.ft.dk`) are served behind a
  Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`) both from the
  development environment and from Vercel functions. The ODA API itself is
  not affected. The file step waits on #38; do not try to circumvent the
  challenge.
- **Other ODA sources:** ODA also offers a nightly database backup
  (`oda.bak`, SQL Server, metadata only, no files) and debate transcripts
  (`ODAXML/Referat/`) on the ODA host's anonymous FTP. Neither has bill
  files.
- **File URL extensions are unreliable:** DOCX files are served from URLs
  ending in `.pdf`. Trust `Fil.format` and check the bytes.
- **Stemme** rows are fetched again only when their
  `Afstemning.opdateringsdato` changes. A live check of 15 votes found the
  vote's timestamp always at or after its newest Stemme, usually by 10 to
  35 ms.
- **Renamed Aktør or Emneord:** the links step re-checks only bills already
  stored. A bill that would become a candidate only through a renamed
  ministry or Emneord is picked up when the bill or one of its links
  changes.
- **Emneord** are inconsistent (the 2024-25 AI Act bill, L 154, is tagged
  "Biblioteker og museer"), so they are one signal among several.
- Not every bill has a vote (e.g. L 211 in 2024-25).

## Inspecting a bill

A bill by number and session, with why it was selected:

```sql
SELECT s.id, s.nummer, p.kode AS session, s.titelkort,
       t.topic, t.matching, t.matched_rules,
       t.first_matched_at, t.last_evaluated_at
FROM sag s
JOIN periode p ON p.id = s.periodeid
LEFT JOIN tracked_sag t ON t.sag_id = s.id
WHERE s.nummer = 'L 211' AND p.titel = '2024-25'  -- periode 163, kode 20241
ORDER BY t.topic;
```

`matched_rules` lists each match as `{ "kind", "value", "field" }`, e.g.
`{"kind": "ministry", "value": "Forsvarsministeriet", "field":
"ministeromraade"}` or `{"kind": "keyword", "value": "drone", "field":
"titel"}`.

Its stages, votes, documents and files:

```sql
SELECT count(*) FROM sagstrin WHERE sagid = 101687;
SELECT a.* FROM afstemning a
  JOIN sagstrin st ON st.id = a.sagstrinid WHERE st.sagid = 101687;
SELECT d.id, d.type, d.titel, f.id AS fil_id, f.format, f.filurl
FROM sag_dokument sd
JOIN dokument d ON d.id = sd.dokumentid
LEFT JOIN fil f ON f.dokumentid = d.id
WHERE sd.sagid = 101687
ORDER BY d.dato, d.id;
```

Candidates per topic, and the latest runs:

```sql
SELECT topic, count(*) FROM tracked_sag WHERE matching GROUP BY topic;

SELECT id, status, started_at, finished_at, error, progress ->> 'step' AS next_step
FROM ingest_run ORDER BY id DESC LIMIT 10;
```
