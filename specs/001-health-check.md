# Spec 001 – Health check for external services

**Status:** Done (epic #4 closed 2026-11-17)
**Owner:** Rune (human)
**Implementer:** Claude Code (agent), via epic and sub-issues

## Goal

Verify that every deployed environment (Development, Preview, Production)
is correctly connected to its own database, blob store and Gemini key,
and build the shared access layers that all later pipeline code must use.

After this spec is implemented, the human can call one protected endpoint
in each environment and see, without exposing any secret, that:

1. Each service is reachable from that environment.
2. Development/Preview and Production use different databases,
   blob stores and Gemini keys.

## Context

Spec 000 established rules in `CLAUDE.md` that code must access Blob
through one helper and Gemini through one model adapter. Those layers do
not exist yet. This spec creates them, together with a database client
and typed environment configuration, and proves they work.

Relevant facts:

- Database: Neon Postgres, connection strings in `DATABASE_URL`
  (pooled) and `DATABASE_URL_UNPOOLED` (direct).
- Blob: private stores, authenticated with Vercel OIDC (ADR 0004). The
  store ID is `BLOB_STORE_ID` in Production and `DEV_BLOB_STORE_ID` in
  Development and Preview (not secret). The credential is
  `VERCEL_OIDC_TOKEN` (secret, short-lived; locally refreshed with
  `vercel env pull .env.local`). There are no read-write tokens.
- Gemini: `GEMINI_API_KEY`, free tier, separate Google projects per
  environment. Only Flash-class models are available on the free tier.
- `VERCEL_ENV` is set by Vercel to `production`, `preview` or
  `development`. Locally it may be missing; treat missing as
  `development`.
- `CRON_SECRET` is added by the human (see prerequisites).

## Prerequisites (human, before implementation starts)

- [ ] Confirm whether Development uses a separate Neon database or
      branch from Production. If not, fix it before any sub-issue that
      touches the database is set to `agent:ready`.
- [ ] Add `CRON_SECRET` in Vercel with a **different** random value for
      Production and for Preview + Development, then run
      `vercel env pull .env.local` again.

## Out of scope

- Database schema or migrations.
- Any pipeline logic (ingest, transform, enrich, review, events).
- Dashboard UI beyond what exists.
- Vercel Cron or Workflow configuration.
- Preview deployment protection bypass. Preview is verified later.

## Deliverables

### 1. Typed environment configuration

- One module that reads and validates environment variables at startup
  using a schema library (e.g. Zod).
- Exposes `environment`: `production`, `preview` or `development`.
- Fails with a clear message naming the **missing variable**, never its
  value.
- All other code reads configuration from this module, never from
  `process.env` directly.

### 2. Database client

- One module that creates the Neon client (serverless driver suitable for
  Vercel Functions) using the pooled `DATABASE_URL`.
- A `checkDatabase()` function that runs `SELECT 1`, measures latency and
  returns a **fingerprint** of the database: the first 8 characters of a
  SHA-256 hash of the host name plus the database name. The fingerprint
  lets the human compare environments without seeing the host.

### 3. Blob helper

- One module that is the only place naming the blob variables. It
  selects `BLOB_STORE_ID` in `production` and `DEV_BLOB_STORE_ID`
  otherwise, reads `VERCEL_OIDC_TOKEN`, and passes `storeId` and
  `oidcToken` explicitly on every SDK call.
- Exposes the operations later code will need: put, get, delete, list
  by prefix. Stores are private.
- A `checkBlob()` function that writes a small fixed object at
  `healthcheck/probe.txt`, reads it back, compares the content and
  deletes it. Returns latency, the **name** of the store ID variable used
  (`storeIdVariable`) and a fingerprint (8-character SHA-256 prefix) of
  the store ID, including its `store_` prefix.

### 4. Gemini model adapter

- One module that is the only place calling Gemini. All model IDs live in
  one configuration object keyed by task (e.g. `healthcheck`, later
  `classify`, `summarise`, `review`), so models can be swapped per task.
- Use the official Google Gen AI SDK. Look up the current free-tier Flash
  or Flash-Lite model ID; do not guess.
- Handles rate limit errors (HTTP 429) with a clear error type, so later
  code can back off.
- A `checkGemini()` function that sends a minimal prompt with a very small
  output limit and verifies a non-empty response. Returns latency and the
  model ID used. Never returns or logs the key.

### 5. Health endpoint

- `GET /api/health`, always dynamic (no caching).
- Requires header `Authorization: Bearer <CRON_SECRET>`. Without a valid
  header it returns 401 with no further information and runs no checks.
- Runs the three checks in parallel with a timeout per check.
- Responds with JSON:

```json
{
  "environment": "production",
  "ok": true,
  "checks": {
    "database": { "ok": true, "latencyMs": 42, "fingerprint": "a1b2c3d4" },
    "blob": {
      "ok": true,
      "latencyMs": 120,
      "storeIdVariable": "BLOB_STORE_ID",
      "fingerprint": "e5f6a7b8"
    },
    "gemini": { "ok": true, "latencyMs": 800, "model": "<model-id>" }
  }
}
```

- HTTP 200 if all checks pass, 503 if any fails. A failed check includes
  a short, non-sensitive `error` string.
- No secret, connection string or token value may ever appear in the
  response or in logs.

### 6. Tests

- Unit tests for each module with the external service mocked. CI must
  never call Neon, Blob or Gemini.
- Unit tests for the endpoint: 401 without or with wrong secret, 200 when
  all checks pass, 503 when one fails, and a test asserting that no
  environment variable value appears in the response body.
- E2E test: `/api/health` without authorisation returns 401.

### 7. Documentation

- `docs/health-check.md`: what the endpoint checks, how to call it
  locally and in production, and how to read the fingerprints.
- `CLAUDE.md`: add the four modules as the mandatory way to access
  configuration, database, blob and Gemini.

## Acceptance criteria

- [ ] All npm scripts from spec 000 pass, and CI is green.
- [ ] No file outside the configuration module reads `process.env`
      (except framework-required files, which must be listed in the PR).
- [ ] No file outside the blob helper references any blob variable
      (`BLOB_STORE_ID`, `DEV_BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN`, and the
      unused `BLOB_READ_WRITE_TOKEN` and `DEV_BLOB_READ_WRITE_TOKEN`).
- [ ] No file outside the Gemini adapter imports the Gemini SDK.
- [ ] Calling `/api/health` locally with the Development secret returns
      200 with `environment: development`.
- [ ] Calling `/api/health` in Production with the Production secret
      returns 200 with `environment: production`.
- [ ] Database and blob fingerprints differ between Development and
      Production. (Amended 2026-11-17 by the human, see epic #4: Gemini was
      dropped from this criterion, because the response shows only the model
      ID and anything derived from the key would be sensitive. That the keys
      come from separate Google projects is checked by hand in the Vercel
      dashboard.)
- [ ] Calling `/api/health` without the secret returns 401 in both
      environments.

The last four criteria are verified by the human after deployment.

## How to work on this spec

1. **Breakdown first.** Read this spec and `CLAUDE.md`. Create one epic
   issue linking to this spec, and sub-issues using the task template,
   each with acceptance criteria and dependencies. Suggested split:
   configuration, database client, blob helper, Gemini adapter, health
   endpoint, documentation. Adjust if you see a better split and explain
   why in the epic.
2. Label the epic `type:epic` and sub-issues `type:task` plus an area
   label. **Do not** add `agent:ready`. Stop and report the breakdown for
   human approval.
3. After approval, the human sets `agent:ready` on issues whose
   dependencies are met. Implement one issue at a time, following the
   workflow rules in `CLAUDE.md`.
