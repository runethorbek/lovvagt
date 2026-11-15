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
- Local development only uses Development environment variables. Never use
  production credentials.
- Blob tokens differ by environment: `BLOB_READ_WRITE_TOKEN` in Production,
  `DEV_BLOB_READ_WRITE_TOKEN` in Development/Preview. Access Blob only through
  the one helper that selects the token from `VERCEL_ENV`. Never use the token
  variables directly anywhere else.
- Call Gemini only through the one model adapter, so models can be swapped per
  task.

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
