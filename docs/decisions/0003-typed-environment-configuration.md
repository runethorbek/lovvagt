# 0003. Typed environment configuration

**Status:** Accepted
**Date:** 2026-11-16

## Context

Lovvagt reads secrets and settings from environment variables: database URLs,
blob tokens, the Gemini key and the cron secret. If any code can read
`process.env` directly, names get misspelt, values are used unvalidated, and
secrets can end up in error messages or logs. The blob tokens also need a
single place that picks the right token for the environment.

Spec 001 asked for validation "at startup". Validating every variable when
the module is imported would make `npm run build` and `npm run test:e2e` fail
in CI, where there are no secrets. It would also let one missing variable
break unrelated code, for example all of the health endpoint's checks instead
of just one. The human confirmed in issue #5 that the intent is to fail early
and clearly, not to fail on import.

## Decision

1. `lib/config.ts` is the only source file that reads `process.env`.
   Framework-required files that cannot import it (currently
   `playwright.config.ts`) are allow-listed. `tests/unit/boundaries.test.ts`
   enforces this.
2. Variables are validated with Zod on **first access** through grouped
   accessors: `config.environment()`, `config.database()`, `config.gemini()`
   and `config.cronSecret()`. Each accessor validates only its own variables,
   every time it is called. Importing the module never throws.
3. `environment()` resolves `VERCEL_ENV` to `production`, `preview` or
   `development`. A missing or empty value means `development`. Any other
   value is rejected.
4. Empty strings count as missing.
5. Errors are `ConfigError`s that name the missing or invalid variables and
   never include values. Zod's own messages are not used, so values cannot
   leak through them.
6. The blob helper owns its part of the schema. `lib/blob/config.ts` names
   both blob token variables, selects one from `environment()` and validates
   it through the generic `readEnv()` from `lib/config.ts`. This keeps both
   rules: only `lib/config.ts` reads `process.env`, and only `lib/blob/` names
   the blob token variables.
7. `lib/fingerprint.ts` provides the shared fingerprint: the first 8 hex
   characters of the SHA-256 of a string. It lets humans compare environments
   without seeing hosts or tokens.

## Consequences

- New variables are added as a new accessor (or a module-owned schema through
  `readEnv()`), not by reading `process.env`.
- A misconfigured service fails when that service is first used, with an
  error naming the variable. Code that never touches it keeps working.
- Validation runs on every call. That is cheap for a handful of variables, and
  it keeps tests simple because there is no cache to reset. Callers that need a
  value often can keep the returned object.
- The boundary test is a text scan. It catches direct and bracket access to
  `process.env`, but not indirect access such as destructuring `process`.
  Reviewers should still watch for that.
