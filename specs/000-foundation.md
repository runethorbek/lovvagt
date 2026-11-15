# Spec 000 – Repository foundation

**Status:** Ready for implementation
**Owner:** Rune (human)
**Implementer:** Claude Code (agent)

## Goal

Set up the foundation that lets AI agents work on Lovvagt with as little
human involvement as possible, while every change stays traceable and
verifiable.

After this spec is implemented, an agent must be able to:

1. Understand the project from `CLAUDE.md` without exploring the codebase.
2. Pick up an issue, implement it on a branch, and open a pull request.
3. Get automatic feedback from CI on whether the change works.

## Context

Lovvagt tracks Danish parliamentary bills (Folketinget) on AI, security
and defence. Data comes from Folketingets Åbne Data (oda.ft.dk). The
planned pipeline is:

ingest → transform → enrich → review → events → dashboard

This spec does **not** build any of that. It builds the workbench.

Infrastructure already exists and must not be changed by the agent:

- GitHub repo with a ruleset on `main` (pull request required, no force push)
- Vercel project `lovvagt` (Next.js preset, functions in Frankfurt)
- Neon Postgres connected via Vercel
- Vercel Blob: `lovvagt-docs` (Production) and `lovvagt-docs-dev`
  (Development + Preview)
- Gemini API keys in separate Google projects for prod and dev
- A dev container (`.devcontainer/devcontainer.json`)

## Out of scope

- Any pipeline logic (ingest, transform, enrich, review, events)
- Database schema or migrations
- Calls to ODA, Gemini, Neon or Blob
- Changes to Vercel, Neon, Google or GitHub settings
- Changes to `.devcontainer/`

## Deliverables

### 1. Minimal Next.js application

- Next.js (App Router), TypeScript in strict mode, npm.
- One page at `/` that shows "Lovvagt" and a one-line description.
  No styling work beyond what is needed to look tidy.
- The app must build and deploy on Vercel without environment variables.

### 2. Tooling and scripts

Add these npm scripts. All must pass on a clean checkout:

| Script         | Purpose                                                  |
| -------------- | -------------------------------------------------------- |
| `lint`         | ESLint                                                   |
| `format:check` | Prettier check                                           |
| `typecheck`    | `tsc --noEmit`                                           |
| `test`         | Unit tests with Vitest                                   |
| `test:e2e`     | Playwright tests against a locally built and started app |
| `build`        | Next.js production build                                 |

Include one Vitest smoke test and one Playwright smoke test that loads `/`
and checks that the heading "Lovvagt" is visible. Playwright uses Chromium
only.

### 3. Continuous integration

`.github/workflows/ci.yml`:

- Triggers on `pull_request` and on `push` to `main`.
- One job named exactly `ci` (it will become a required status check).
- Steps: checkout, set up Node 22 with npm cache, `npm ci`, `lint`,
  `format:check`, `typecheck`, `test`, `build`, install Playwright
  Chromium, `test:e2e`.
- E2E tests run against the app started inside the CI job, **not**
  against Vercel preview deployments.
- No secrets are used.

### 4. `CLAUDE.md`

The single source of context for agents. Keep it concise and factual.
It must contain:

**Project**

- What Lovvagt is and the pipeline stages (one line each).
- Stack: Next.js, TypeScript, Vercel (Cron, Workflow, Blob), Neon
  Postgres, Gemini.
- Commands: how to run, test, lint, build.

**Glossary**
Danish domain terms keep their Danish names in code, because they mirror
the ODA data model. Do not translate them.

| Term        | Meaning                                  |
| ----------- | ---------------------------------------- |
| Sag         | A parliamentary case, e.g. a bill        |
| Sagstrin    | A stage in a case's process              |
| Lovforslag  | Bill                                     |
| Afstemning  | A vote (voting session)                  |
| Stemme      | An individual MP's vote                  |
| Aktør       | Actor: MP, committee, party, ministry    |
| Dokument    | Document attached to a case              |
| Fil         | File belonging to a document (PDF, DOCX) |
| Høringssvar | Consultation response                    |

Everything else (code, comments, docs, issues, commits) is in English.

**Environment rules**

- Never read, print, log or commit values from `.env*` files.
- Local development only uses Development environment variables.
  Never use production credentials.
- Blob tokens differ by environment (`BLOB_READ_WRITE_TOKEN` in
  Production, `DEV_BLOB_READ_WRITE_TOKEN` in Development/Preview).
  Code must only access Blob through one helper that selects the token
  from `VERCEL_ENV`. Never use the token variables directly elsewhere.
- Gemini must only be called through one model adapter, so models can be
  swapped per task.

**Workflow rules**

- Work only on issues labelled `agent:ready`. Set `agent:in-progress`
  when starting.
- One issue per branch, one branch per pull request.
- Branch names: `<type>/<issue-number>-<short-slug>`,
  e.g. `feat/12-ingest-sager`.
- Commits follow Conventional Commits.
- Pull request description includes `Closes #<issue>` and how the
  acceptance criteria were verified.
- When done, comment on the issue: what was done, what was discovered,
  what was uncertain.
- If blocked or unsure about intent, label the issue `needs-human`,
  explain why in a comment, and stop.
- Architecture decisions are recorded in `docs/decisions/`.

**Definition of done**

- All acceptance criteria in the issue are met.
- CI is green.
- New behaviour is covered by tests.
- No unrelated changes in the pull request.

**Never**

- Push to `main` or force push.
- Disable, skip or weaken tests or CI to make them pass.
- Change secrets, environment variables or infrastructure settings.
- Add a dependency without stating why in the pull request.
- Run database migrations against anything other than a development
  database.

### 5. `.env.example`

Variable names only, no values, each with a one-line comment:
`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BLOB_READ_WRITE_TOKEN`,
`DEV_BLOB_READ_WRITE_TOKEN`, `GEMINI_API_KEY`.

### 6. Issue and pull request templates

- `.github/ISSUE_TEMPLATE/epic.yml`: link to spec, goal, list of
  expected sub-issues, out of scope.
- `.github/ISSUE_TEMPLATE/task.yml`: description, acceptance criteria
  (checklist), dependencies, out of scope, notes for the agent.
- `.github/ISSUE_TEMPLATE/config.yml`: disable blank issues.
- `.github/pull_request_template.md`: linked issue, summary, how
  acceptance criteria were verified, new dependencies (with reason),
  anything the reviewer should look at.

### 7. Labels

Create `scripts/setup-labels.sh` using `gh label create --force` and run
it once. Labels:

- State: `agent:ready`, `agent:in-progress`, `needs-human`, `blocked`
- Type: `type:epic`, `type:task`, `type:bug`
- Area: `area:ingest`, `area:transform`, `area:enrich`, `area:review`,
  `area:events`, `area:dashboard`, `area:platform`

### 8. Decision records

`docs/decisions/` with:

- `0001-record-architecture-decisions.md`: why and how decisions are
  recorded (short ADR format: context, decision, consequences).
- `0002-stack-and-infrastructure.md` recording these decisions:
  - Next.js and TypeScript on Vercel, Hobby plan for the proof of concept.
  - Daily Vercel Cron triggering a Vercel Workflow for the pipeline;
    each stage and each review as separate durable steps.
  - Neon Postgres in Frankfurt for metadata, extracted text and events.
  - Original documents stored in Vercel Blob, separate stores for
    production and development/preview.
  - Gemini free tier, separate Google projects for prod and dev, all
    calls through a model adapter.
  - Agentic review: three independent reviewers (faithfulness,
    completeness, neutrality), deterministic decision rule, escalation
    to a stronger judge only on disagreement.
  - Code in English, ODA domain terms in Danish.

### 9. Specs folder

- Save this document as `specs/000-foundation.md`.
- `specs/README.md`: how specs are written (goal, context, out of scope,
  deliverables, acceptance criteria) and how they become an epic with
  sub-issues.

## Acceptance criteria

- [ ] `npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run test:e2e` passes in the dev container.
- [ ] CI job `ci` runs and passes on the pull request.
- [ ] `CLAUDE.md` contains all sections listed in deliverable 4.
- [ ] `.env.example` contains only variable names.
- [ ] Issue templates appear when creating a new issue on GitHub.
- [ ] All labels in deliverable 7 exist in the repository.
- [ ] Both decision records exist and match deliverable 8.
- [ ] No `.env*` file other than `.env.example` is committed.
- [ ] No changes to `.devcontainer/`.

## How to work on this spec

- Work on branch `chore/0-foundation` and open **one** pull request.
  (The issue workflow does not exist yet, so this spec is the exception.)
- Before starting, list any questions about intent. If none, proceed.
- At the end, report: what was done, any deviations from this spec and
  why, and anything the human must do.

## Human follow-up after merge

1. Add the status check `ci` as required in the `main` ruleset.
2. Confirm the Vercel production deployment now succeeds.
