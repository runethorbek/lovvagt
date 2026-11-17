# Health check

`GET /api/health` checks that a deployment can reach its database, blob
store and Gemini, and shows which ones it uses without exposing any
secret. It is implemented in `app/api/health/route.ts` and
`lib/health.ts` (spec 001).

## What it checks

The three checks run in parallel. Each has a 10-second timeout
(`checkTimeoutMs` in `lib/health.ts`); a check that does not finish in
time is reported as failed with `error: "timeout"`.

| Check      | What it does                                                                                                                        | Module         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `database` | Runs `SELECT 1` on the pooled `DATABASE_URL`.                                                                                       | `lib/db.ts`    |
| `blob`     | Writes `healthcheck/probe.txt` to the environment's private store, reads it back (bypassing the cache), compares it and deletes it. | `lib/blob/`    |
| `gemini`   | Sends a one-line prompt to the `healthcheck` model with a 16-token output limit and checks that the reply is not empty.             | `lib/model.ts` |

Each Gemini check uses a small part of the free-tier quota, so do not
poll the endpoint.

## Authorisation

The endpoint requires the header `Authorization: Bearer <CRON_SECRET>`.
The secret is compared in constant time. Without a valid header, or if
`CRON_SECRET` is not configured in that environment, it returns **401**
with an empty body and runs no checks. `CRON_SECRET` has a different value
in Production than in Preview and Development.

## Response

The response is never cached (`Cache-Control: no-store`, and the route is
always dynamic). The status is **200** if every check passes and **503**
if any fails.

```json
{
  "environment": "development",
  "ok": true,
  "checks": {
    "database": { "ok": true, "latencyMs": 42, "fingerprint": "a1b2c3d4" },
    "blob": {
      "ok": true,
      "latencyMs": 120,
      "storeIdVariable": "DEV_BLOB_STORE_ID",
      "fingerprint": "e5f6a7b8"
    },
    "gemini": { "ok": true, "latencyMs": 800, "model": "gemini-3.5-flash-lite" }
  }
}
```

- `environment` is `VERCEL_ENV` (`production`, `preview` or
  `development`; missing means `development`). It is `null`, and the
  status 503, if `VERCEL_ENV` holds any other value.
- A failed check has `ok: false` and a short fixed `error` string instead
  of the fingerprint, for example `"connection failed"`, `"write failed"`,
  `"rate limited"`, `"configuration missing or invalid"`, `"timeout"`.
  Failed blob checks still name `storeIdVariable`, and failed Gemini
  checks still name `model`.
- No secret, connection string, token, store ID or API key is ever in the
  response, and the endpoint logs nothing.

## Calling it locally

Pull the Development variables, start the app and call the endpoint with
the Development secret. The command reads the secret from `.env.local`
without printing it:

```sh
vercel env pull .env.local   # also refreshes the short-lived VERCEL_OIDC_TOKEN
npm run dev
curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $(grep '^CRON_SECRET=' .env.local | cut -d= -f2- | tr -d '"')" \
  http://localhost:3000/api/health
```

Expect HTTP 200 with `"environment": "development"` and
`"storeIdVariable": "DEV_BLOB_STORE_ID"`. Locally, the blob check uses
`VERCEL_OIDC_TOKEN` from `.env.local`, which expires after a few hours. If
the blob check fails with `"access denied"`, the token has probably
expired; if it fails with `"configuration missing or invalid"`, the token
or `DEV_BLOB_STORE_ID` is missing. Either way, pull `.env.local` again.

In deployed functions the token is not an environment variable: Vercel
sends it with each request in the `x-vercel-oidc-token` header (ADR 0005).
A `"configuration missing or invalid"` blob error in a deployment means
that the header was missing (check that OIDC is enabled for the project)
or that the store ID variable is not set for that environment.

## Calling it in Production

Use the Production secret from the Vercel dashboard (Settings →
Environment Variables → `CRON_SECRET`, Production). Do not store it in
the shell history: read it into a variable first.

```sh
read -rs CRON_SECRET_PROD   # paste the Production secret, then Enter
curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $CRON_SECRET_PROD" \
  https://<production-domain>/api/health
unset CRON_SECRET_PROD
```

Expect HTTP 200 with `"environment": "production"` and
`"storeIdVariable": "BLOB_STORE_ID"`.

Without the header, both environments must return 401:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<production-domain>/api/health
```

## Reading the fingerprints

A fingerprint is the first 8 hex characters of a SHA-256 hash
(`lib/fingerprint.ts`). It identifies a resource without revealing it, so
two environments can be compared.

| Field                         | Hash input                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks.database.fingerprint` | `<host>/<database>` from the pooled `DATABASE_URL`: lowercase host without port, then the database name (see `fingerprintInput()` in `lib/db.ts`). |
| `checks.blob.fingerprint`     | The store ID, including its `store_` prefix.                                                                                                       |

To confirm that the environments are separate, call the endpoint locally
(Development) and in Production and compare:

- `checks.database.fingerprint` must differ. Equal fingerprints mean both
  environments use the same Neon branch and database.
- `checks.blob.fingerprint` must differ, and `storeIdVariable` must be
  `DEV_BLOB_STORE_ID` locally and `BLOB_STORE_ID` in Production. Blob is
  authenticated with Vercel OIDC (ADR 0004), so the store ID, not a token,
  decides which store is used.
- `checks.gemini.model` is the model ID, not a fingerprint. It is the same
  in every environment by design. The response cannot show which Google
  project the key belongs to; check that in the Vercel dashboard (the
  Production and Development `GEMINI_API_KEY` values come from different
  projects).

To check which store a fingerprint belongs to, hash its store ID (store
IDs are not secret; they are shown in the Vercel dashboard):

```sh
printf '%s' 'store_…' | sha256sum | cut -c1-8
```
