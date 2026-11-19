# CLAUDE.md

Context for agents working on Lovvagt. Read this before starting any task.

## Project

Lovvagt tracks Danish parliamentary bills (Folketinget) on AI, security and
defence. Data comes from Folketingets Åbne Data (ODA, https://oda.ft.dk).

Pipeline stages (planned; not yet built):

1. **ingest**: fetch cases, documents and files from ODA.
2. **transform**: normalise ODA records and extract text from files.
3. **enrich**: use an LLM to classify relevance and summarise.
4. **review**: independent agentic reviewers check each enrichment.
5. **events**: detect and record changes worth reporting (new stage, vote, etc.).
6. **dashboard**: the Next.js web app that presents bills and events.

### Stack

- Next.js (App Router) and TypeScript (strict), npm, on Vercel.
- Vercel Cron triggers a Vercel Workflow that runs the pipeline as durable steps.
- Vercel Blob stores original documents.
- Neon Postgres (Frankfurt) stores metadata, extracted text and events.
- Gemini is the LLM, called only through the model adapter.
- Vitest for unit tests, Playwright (Chromium) for end-to-end tests.

Architecture decisions are in `docs/decisions/`. Specs are in `specs/`.

### Commands

| Command                | What it does                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| `npm ci`               | Install dependencies                                                             |
| `npm run dev`          | Start the dev server on http://localhost:3000                                    |
| `npm run lint`         | ESLint                                                                           |
| `npm run format:check` | Prettier check (`npm run format` to fix)                                         |
| `npm run typecheck`    | Generate Next.js types, then `tsc --noEmit`                                      |
| `npm test`             | Vitest unit tests (`tests/unit/`)                                                |
| `npm run build`        | Next.js production build                                                         |
| `npm run test:e2e`     | Playwright tests (`tests/e2e/`) against the built app; run `npm run build` first |
| `npm run db:migrate`   | Apply pending SQL migrations in `db/migrations/` (development database only)     |

Run the same sequence as CI before opening a pull request:
`npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run test:e2e`.
If Chromium is missing locally: `npx playwright install --with-deps chromium`.

## Glossary

Danish domain terms keep their Danish names in code, because they mirror the
ODA data model. Do not translate them.

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

## Environment rules

- Never read, print, log or commit values from `.env*` files. `.env.example`
  lists the variable names.
- Read configuration only through `lib/config.ts`. No other source file may
  use `process.env` (framework-required files are allow-listed in
  `tests/unit/boundaries.test.ts`, which enforces this). Use the grouped
  accessors (`config.environment()`, `config.database()`, `config.gemini()`,
  `config.cronSecret()`); add a new group there for new variables. See ADR 0003.
- Local development only uses Development environment variables. Never use
  production credentials.
- Blob uses Vercel OIDC, not read-write tokens (ADR 0004). The store ID
  differs by environment: `BLOB_STORE_ID` in Production, `DEV_BLOB_STORE_ID`
  in Development/Preview. The credential is a secret, short-lived OIDC
  token: in deployed functions it comes per request from the
  `x-vercel-oidc-token` header (via `@vercel/oidc`), locally from
  `VERCEL_OIDC_TOKEN` (ADR 0005). Access Blob only through the helper in `lib/blob/`
  (`lib/blob/index.ts`), which selects the store ID from `VERCEL_ENV`
  (`lib/blob/config.ts`) and passes `storeId` and `oidcToken` explicitly on
  every SDK call. No other code may import `@vercel/blob` or `@vercel/oidc`, or name
  `BLOB_STORE_ID`, `DEV_BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN`,
  `BLOB_READ_WRITE_TOKEN` or `DEV_BLOB_READ_WRITE_TOKEN` (enforced by
  `tests/unit/boundaries.test.ts`). Never pass SDK error messages on.
- Access the database only through `lib/db.ts` (`db()` for queries,
  `executor()` for code that takes a `SqlExecutor` so it can be tested on
  PGlite, `checkDatabase()` for the health probe). No other code may import
  `@neondatabase/serverless` or call `config.database()`. Never pass driver
  error messages on: they can contain the connection string.
- Schema changes are plain SQL migrations in `db/migrations/`
  (`NNNN_short_name.sql`), applied by `npm run db:migrate` (ADR 0006). Never
  edit an applied migration; add a new one. Agents only migrate the
  development database: never pass `--environment=preview` or
  `--environment=production`; the human migrates those. Test SQL against
  PGlite with `tests/support/pglite.ts`, never against Neon.
- Call Gemini only through the model adapter `lib/model.ts` (`generateText()`
  with a task name, `checkGemini()` for the health probe), so models can be
  swapped per task. Model IDs live only in its `models` object, keyed by task;
  add a key there for a new task. No other code may import `@google/genai`
  (enforced by `tests/unit/boundaries.test.ts`) or call `config.gemini()`.
  Catch `RateLimitError` (HTTP 429) to back off. Never pass SDK error
  messages on, and never log the key.

## Workflow rules

- Work only on issues labelled `agent:ready`. Set `agent:in-progress` when
  starting.
- One issue per branch, one branch per pull request.
- Branch names: `<type>/<issue-number>-<short-slug>`, e.g. `feat/12-ingest-sager`.
- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`,
  `test:`, `refactor:`, ...).
- The pull request description includes `Closes #<issue>` and how each
  acceptance criterion was verified (use the PR template).
- When done, comment on the issue: what was done, what was discovered, what
  was uncertain.
- If blocked or unsure about intent, label the issue `needs-human`, explain why
  in a comment, and stop.
- Record architecture decisions in `docs/decisions/` (see ADR 0001).

## Sessions

- At the start of a session, read ROADMAP.md before doing anything else.
- ROADMAP.md is the source of truth for project status. Never mark a
  phase done unless its epic is closed and its acceptance criteria are met.
- At the end of a session, or when an epic is closed, update ROADMAP.md
  (Where we are, phase status, open items, session log) in a pull request.
- Use the /status command to start a session and /wrap-up to end one.

## Definition of done

- All acceptance criteria in the issue are met.
- CI (job `ci`) is green.
- New behaviour is covered by tests.
- No unrelated changes in the pull request.

## Never

- Push to `main` or force push.
- Disable, skip or weaken tests or CI to make them pass.
- Change secrets, environment variables or infrastructure settings.
- Add a dependency without stating why in the pull request.
- Run database migrations against anything other than a development database.
