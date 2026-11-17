# 0005. Blob OIDC token at runtime from the request context

**Status:** Accepted
**Date:** 2026-11-17

## Context

ADR 0004 reads the Blob OIDC token only from the `VERCEL_OIDC_TOKEN`
environment variable. It noted the risk that the variable might be missing
at runtime.

That happened. In Production, `GET /api/health` reported the blob check as
`"configuration missing or invalid"` after 1 ms, with `BLOB_STORE_ID` set
(issue #21). Inside a Vercel Function, the OIDC token is not an environment
variable. Vercel delivers it per request in the `x-vercel-oidc-token` header,
exposed through the request context (the `@vercel/request-context` global).
`VERCEL_OIDC_TOKEN` exists only locally (from `vercel env pull`) and during
builds.

`@vercel/oidc` 3.8.10, already installed as a dependency of `@vercel/blob`,
reads the token as `getContext().headers["x-vercel-oidc-token"]`, falling
back to the variable.

## Decision

1. `lib/blob/config.ts` takes the token from the request context first,
   using `getContext()` from `@vercel/oidc`. A missing or blank header falls
   back to `VERCEL_OIDC_TOKEN`, read through `readEnv()` as before. The
   variable is required only when the header has no token, so a missing
   token is still a `ConfigError` naming `VERCEL_OIDC_TOKEN`.
2. `getContext()` is used instead of `getVercelOidcTokenSync()` so that the
   environment fallback still goes through `lib/config.ts` (ADR 0003).
   `getVercelOidcToken()` is not used, because it may refresh the token
   with local Vercel CLI credentials.
3. `@vercel/oidc` becomes a direct dependency, pinned to the version
   `@vercel/blob` resolves (3.8.10), so there is only one copy. Only
   `lib/blob/` and `tests/unit/blob.test.ts` may import it, which
   `tests/unit/boundaries.test.ts` enforces.
4. Everything else in ADR 0004 still applies. `storeId` and `oidcToken` are
   passed explicitly on every SDK call, and there is no read-write token
   fallback.

## Consequences

- Blob works in deployed functions (Production and Preview) without any
  change to environment variables.
- The token is per request, so it must be read at call time, inside the
  request. `blobConfig()` already does this on every call. Code that runs
  outside a request (for example a future Workflow step) must be checked
  for how the token is delivered there.
- When `@vercel/blob` is upgraded, keep `@vercel/oidc` at the version it
  resolves to.
