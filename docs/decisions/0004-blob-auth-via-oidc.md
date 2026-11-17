# 0004. Blob authentication via Vercel OIDC

**Status:** Accepted; decision 2 amended by ADR 0005 (token at runtime)
**Date:** 2026-11-16

## Context

Spec 000, spec 001, ADR 0002 (decision 4) and ADR 0003 (decision 6) assumed
that Vercel Blob is accessed with read-write tokens: `BLOB_READ_WRITE_TOKEN`
in Production and `DEV_BLOB_READ_WRITE_TOKEN` in Development and Preview.

The stores are not set up that way. No environment has a read-write token.
The stores are connected to the project by store ID, and Vercel provides an
OIDC token instead:

| Variable            | Environments                                                   | Secret? |
| ------------------- | -------------------------------------------------------------- | ------- |
| `BLOB_STORE_ID`     | Production                                                     | No      |
| `DEV_BLOB_STORE_ID` | Preview, Development                                           | No      |
| `VERCEL_OIDC_TOKEN` | Set by Vercel; in `.env.local` via `vercel env pull` (expires) | **Yes** |

`@vercel/blob` 2.9.0 supports this for `put`, `get`, `del` and `list` through
the `oidcToken` and `storeId` options. If those are not passed, the SDK falls
back to its own lookup: `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID`, then
`BLOB_READ_WRITE_TOKEN`. That lookup would ignore `DEV_BLOB_STORE_ID` and could
silently use the production store from a development environment. The human
decided on 2026-11-16 (issue #7) to use OIDC.

## Decision

1. Blob is authenticated with Vercel OIDC. Read-write tokens are not used,
   and there is no fallback to them.
2. `lib/blob/config.ts` selects the store ID variable from `environment()`:
   `BLOB_STORE_ID` in `production`, `DEV_BLOB_STORE_ID` otherwise. It reads
   that variable and `VERCEL_OIDC_TOKEN` through `readEnv()`.
3. `lib/blob/index.ts` is the only code that calls the Blob SDK. It passes
   `storeId` and `oidcToken` explicitly on every call, so the SDK's own
   environment lookup is never relied on. All objects are private.
4. Only `lib/blob/` and its test file (`tests/unit/blob.test.ts`) may name
   `BLOB_STORE_ID`, `DEV_BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN`,
   `BLOB_READ_WRITE_TOKEN` or `DEV_BLOB_READ_WRITE_TOKEN`.
   `tests/unit/boundaries.test.ts` enforces this for source files.
5. The blob fingerprint in the health check is `fingerprint()` of the store ID
   exactly as stored in the variable (trimmed, including the `store_` prefix).
   The store ID is not secret, so no token parsing is needed.
6. SDK errors are mapped to fixed messages. SDK error text is never passed on,
   because it could contain the token or request details.

This supersedes the read-write token part of spec 000, ADR 0002 (decision 4)
and ADR 0003 (decision 6). The rest of those records still applies.

## Consequences

- No long-lived blob secret exists. The only blob secret is the short-lived
  OIDC token.
- Locally, `VERCEL_OIDC_TOKEN` in `.env.local` expires. When blob calls fail
  with an access error, re-run `vercel env pull .env.local`.
- The token is read from the environment only. In Vercel Functions,
  `@vercel/oidc` prefers the per-request `x-vercel-oidc-token` header and
  falls back to `VERCEL_OIDC_TOKEN`. If the environment variable turns out to
  be missing or stale at runtime, the health check will report a
  configuration or access error; the fix would be to obtain the token through
  `@vercel/oidc` inside `lib/blob/` and record that in a new ADR.
- Client-side uploads are not possible without a read-write token. They are
  out of scope.
