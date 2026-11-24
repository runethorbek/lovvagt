# Lovvagt roadmap

This file is the single place to see where the project stands.
Update **Where we are** at the end of every work session.

## Where we are

**Last updated:** 2026-11-24

**Current phase:** 2 – Ingest (spec 002, epic #32)

**Next action:**

1. Human migrates Preview and Production (`0001_initial` and
   `0002_ingest_run_progress`, `npm run db:migrate -- --environment=<name>`),
   then checks in Production: `POST /api/ingest` without the secret returns
   401, `scripts/ingest-until-done.ts <prod-url>` runs until `done: true`,
   candidate counts per topic match Development (ai 16, defence 20,
   security 32), and Vercel logs show no timeouts.
2. Human sends the drafted email to Folketingets Informationscenter
   (`fo@ft.dk`) about automated access to `Fil.filurl` documents, if not
   yet sent.
3. Human decides on the committee-referral rule kind proposed on #35
   (SagAktør role 11, `Henvist til`).

**Blocked on:** #38 (`needs-human`), the last open issue in epic #32:
`www.ft.dk`, where bill files are served, answers automated clients with a
Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`), both from the
dev environment and from a Vercel Preview function (probe, 2026-11-20). The
ODA API is not affected. #38 also still needs the Blob usage check (spec
002 prerequisite). ODA's other sources do not help: the nightly database
backup is metadata only, and the anonymous FTP holds only debate
transcripts. If the block stays, spec 002 may need amending (the L 211 file
criterion) so the epic can close.

## How to resume after a break

1. Read **Where we are** above.
2. Open the current epic on GitHub and check which sub-issues are open,
   in progress or labelled `needs-human`.
3. Check **Open items** below for anything that must happen before the
   next phase.

## Product

Lovvagt follows bills in Folketinget on selected topics (AI, security,
defence) and shows how many there are, their timelines and who they
affect. It is also a learning project: building a product mostly through
orchestrated AI agents, with the human setting direction and reviewing
outcomes.

Pipeline: ingest → transform → enrich → review → events → dashboard.

Out of scope for the proof of concept: customer subscriptions,
notifications, multi-tenant accounts, EU legislation.

## Phases

Status: ✅ done · 🟡 in progress · ⬜ not started

| #   | Phase                                                                                                                                             | Spec | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ |
| 0   | Foundation: infrastructure, dev container, CI, CLAUDE.md, templates                                                                               | 000  | ✅     |
| 1   | Connectivity: config, database, blob, Gemini access layers + health check                                                                         | 001  | ✅     |
| 2   | Ingest: fetch cases, stages, votes and documents for tracked topics from ODA; store originals in Blob                                             | 002  | 🟡     |
| 3   | Transform: extract text (prefer DOCX over PDF), split into sections, track document versions                                                      | 003  | ⬜     |
| 4   | Enrich: topic classification, summaries with source references, extract consequences from the bill's general remarks                              | 004  | ⬜     |
| 5   | Review: three independent reviewers (faithfulness, completeness, neutrality), deterministic decision rule, judge on disagreement, golden test set | 005  | ⬜     |
| 6   | Events: detect stage changes, append-only event log, timelines                                                                                    | 006  | ⬜     |
| 7   | Dashboard: tracked bills per topic, timelines, who is affected                                                                                    | 007  | ⬜     |
| 8   | Automation: daily Vercel Cron → Workflow; agents triggered from issues                                                                            | 008  | ⬜     |

## Phase 0 checklist (done)

- ✅ Public GitHub repo with ruleset on `main` (PR required, no force push, squash merge only)
- ✅ Vercel project (Next.js; functions in Frankfurt `fra1`, set in the dashboard 2026-11-17)
- ✅ Neon Postgres via Vercel: `main` for Production (integration); `preview` branch for Preview and `dev` branch for Development (both created 2026-11-17, variables set by hand)
- ✅ Blob stores: `lovvagt-docs` (Production), `lovvagt-docs-dev` (Development + Preview)
- ✅ Gemini keys in separate Google projects (prod, dev)
- ✅ Dev container with Claude Code, GitHub CLI and Vercel CLI
- ✅ Spec 000 implemented by the agent and deployed to production

## Open items

Things that are known but not yet handled. Move them into a spec when
they become relevant.

| Item                                                                                                                                                                                                                  | Needed before              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Migrate Preview and Production to `0001_initial` (`npm run db:migrate -- --environment=<name>`, human only)                                                                                                           | Phase 2 deploy             |
| Enable **Allow GitHub Actions to create and approve pull requests** (Settings → Actions → General), human only                                                                                                        | Next skills sync           |
| Preview deployment protection bypass for automated browser tests                                                                                                                                                      | Phase 7                    |
| Dev container: host Git credentials are forwarded, so the scoped GitHub token is not airtight                                                                                                                         | Agent automation (phase 8) |
| Dev container: network firewall (see Anthropic's reference dev container)                                                                                                                                             | Agent automation (phase 8) |
| Restrict Gemini keys to the Generative Language API in Google Cloud (verify)                                                                                                                                          | Phase 4                    |
| `npm audit`: high findings via `@vercel/blob` → `@vercel/oidc` → `@vercel/cli-config` → `zod@4.1.11`; moderate via eslint `minimatch`                                                                                 | Any time (upstream fix)    |
| Blob OIDC token outside a request (Workflow steps, cron): check how Vercel delivers it there (ADR 0005)                                                                                                               | Phase 8                    |
| Gemini free-tier limits are not published per model; watch the AI Studio rate-limit dashboard (limits are per project)                                                                                                | Phase 4                    |
| Gemini health check takes ~8 s against a 10 s timeout (`checkTimeoutMs`); raise it or give Gemini its own timeout if it starts timing out                                                                             | Phase 4                    |
| `www.ft.dk` bill files blocked by a Cloudflare challenge (dev and Vercel); ask Folketinget, do not circumvent                                                                                                         | #38, phase 3               |
| ODA timestamps verified as Copenhagen time in winter only; re-check summer time after 2027-03-28 (noted in `docs/ingest.md`)                                                                                          | 2027-03-28                 |
| Committee-referral rule kind (SagAktør role 11, `Henvist til`) proposed on #35: human decision                                                                                                                        | Topic rule tuning          |
| Ingest follow-ups (#51 review): split `lib/ingest/steps.ts` (~1,450 lines) into bills/links/children modules; drop the duplicate first-run phase-2 skip                                                               | Any time                   |
| Ingest route follow-ups (#53 review): take the lease and read the run id in one statement (a failed second query blocks calls with 409 for up to 10 min); verify the Preview `vercel curl` syntax in `docs/ingest.md` | Phase 8                    |
| Full backfill from an empty database through `POST /api/ingest` not yet run (dev data came from `scripts/ingest-steps.ts`); the Production backfill will be the first                                                 | Production backfill        |
| Ingest guard (#50 review): fail if an ODA page does not advance the id cursor (would loop until the time budget)                                                                                                      | Phase 8                    |
| Rows deleted in ODA are not removed (out of scope in spec 002, noted in `docs/ingest.md`)                                                                                                                             | Phase 6 (events)           |
| ODA client follow-ups (#46 review): abort while waiting for the lock; redirect hops; `fetchDokument`/`fetchFil` tests                                                                                                 | Phase 8                    |
| Preview `CRON_SECRET` replaced 2026-11-20 (Sensitive, cannot be read back); keep the value outside Vercel                                                                                                             | Any Preview check          |
| ODA bulk sources: nightly `oda.bak` (SQL Server, metadata) and debate transcripts on `ftp://oda.ft.dk/ODAXML/Referat/`                                                                                                | Phase 6 (transcripts)      |
| Consider moving the repo into the WSL file system if the container feels slow                                                                                                                                         | Any time                   |
| Vercel Hobby is for non-commercial use; revisit if Lovvagt becomes a product                                                                                                                                          | Before any commercial use  |

## Working agreements

- Specs live in `specs/`, decisions in `docs/decisions/`, agent rules in
  `CLAUDE.md`.
- Each spec becomes an epic with sub-issues. The human approves the
  breakdown and sets `agent:ready`.
- Agents are run manually, one issue at a time, until they reliably
  complete issues without help. Then automate.
- Issues are implemented with `/build-slice <issue>`: an implementer
  subagent builds, a fresh read-only reviewer subagent reviews each round
  (skills synced from `runethorbek/skills`; see CLAUDE.md).
- The human's checkpoints: writing specs, approving breakdowns,
  verifying acceptance criteria that need real environments.

## Session log

Newest first. One or two lines per session.

- **2026-11-24** – Agent implemented #39 (#53) with `/build-slice` (one
  review round, PASS): `POST /api/ingest` with lease, 240 s budget and
  progress saved across calls (migration `0002`), `scripts/ingest-until-done.ts`,
  `docs/ingest.md`. Development migrated; local catch-up then a second call
  with zero writes; live checks of 409 and multi-call resume. #38 is the
  only open issue in epic #32.
- **2026-11-23** – Answered the #51 review questions with live ODA checks:
  15 votes show `Afstemning.opdateringsdato` at or after their newest
  `Stemme`; `Fil` rows are identical from both queries. Notes for
  `docs/ingest.md` left on #39.
- **2026-11-22** – Agent implemented #36 (#50) and #37 (#51) with
  `/build-slice` (two review rounds each). Development database now holds
  60 candidate bills (defence 20, security 32, ai 16) with stages, votes,
  documents and files; a second run writes nothing (30 ODA requests).
  Human added link and actor change detection to #37.
- **2026-11-20** – Agent implemented #35 (#49) with `/build-slice`: topic
  rules in `lib/ingest/topics.ts`; human tuned them after a dry run over
  548 bills (75 → 60 candidates).
- **2026-11-20** – Read ODA's browser guide: no other source for bill
  files (backup is metadata, FTP only transcripts); contact is likely
  `fo@ft.dk`, email drafted. Posted ODA findings on #35, #36, #37, #39;
  probe branch deleted.
- **2026-11-20** – Agent implemented #34 with `/build-slice` (#46, two
  review rounds): ODA client in `lib/oda/` with recorded fixtures; live API
  check confirmed ODA timestamps are Copenhagen local time (winter). Found
  that `www.ft.dk` file downloads get a Cloudflare challenge from dev and
  from Vercel (throwaway probe); #38 labelled `needs-human`.
- **2026-11-19** – Added shared Claude Code skills from
  `runethorbek/skills` via a sync workflow (#43, #44): `/build-slice` with
  `slice-implementer`/`slice-reviewer` subagents, `/agent-ready`,
  `/draft-issue`; CLAUDE.md says how they fit Lovvagt's rules.
- **2026-11-19** – Wrote spec 002 (#31, #40) and broke it into epic #32
  with sub-issues #33–#39. Agent implemented #33 (#41): migration runner,
  `0001_initial` schema, PGlite SQL harness, ADR 0006; development database
  migrated. Schema choices confirmed (no FKs between ODA tables, DB-enforced
  ingest lease); skipped-file storage moved to #38.
- **2026-11-19** – Status check: #28 and #29 merged, no open epic or
  issues. Updated next action to spec 002.
- **2026-11-17** – Verified spec 001 in both environments and closed epic #4
  (phase 1 done). Found and fixed: Development had no working database (no
  `dev` branch; created), blob OIDC token at runtime (#21, ADR 0005) and
  misleading database auth error (#22). Gemini dropped from the
  "fingerprints differ" criterion. Gave Preview its own Neon `preview`
  branch (Preview removed from the Neon integration). Moved functions from
  `iad1` to Frankfurt (`fra1`); Production health check re-verified. Ticked
  spec 001's criteria (#27) and opened #28 to commit `AGENTS.md`.
- **2026-11-16** – Added session protocol. Agent implemented spec 001
  issues #5 (config), #6 (database), #7 (blob, OIDC), #8 (Gemini adapter,
  `gemini-3.5-flash-lite`), #14 (Neon driver upgrade) and #9 (protected
  `GET /api/health` with 10 s per-check timeout, `docs/health-check.md`).
  All spec 001 code is merged; deployment criteria await human checks.
- **2026-11-15** – Chose the project and architecture. Set up GitHub,
  Vercel, Neon (with `dev` branch), Blob, Gemini and the dev container.
  Agent implemented spec 000. Wrote spec 001.
