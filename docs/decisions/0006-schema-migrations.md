# 0006. Schema migrations

**Status:** Accepted
**Date:** 2026-11-19

## Context

Spec 002 adds Lovvagt's first database schema. Schema changes must be
reviewable in pull requests, applied the same way in every environment, and
never applied to Preview or Production by accident (CLAUDE.md: agents only
migrate the development database). The spec asks for plain SQL, no ORM and
preferably no new runtime dependency.

Constraints:

- `lib/db.ts` is the only module that may use the Neon driver, and it uses
  Neon's HTTP driver. Over HTTP every query is one request and one
  statement, and there are no session-level features (no `BEGIN` across
  requests, no advisory locks). The driver does support non-interactive
  transactions: `sql.transaction([...])` runs a fixed list of statements in
  one Postgres transaction.
- CI must test SQL without network access to Neon.
- `@/` path aliases do not resolve in plain `node`.

## Decision

1. **Files.** Migrations are plain SQL files in `db/migrations/`, named
   `NNNN_short_name.sql` (four digits, lowercase snake_case). They are
   applied in name order. Any other `.sql` file name, or two files with the
   same number, is an error. Applied migrations are never edited; a change
   is a new migration.
2. **Tracking.** `schema_migrations (name, checksum, applied_at)` records
   each applied migration. The checksum is the SHA-256 of the file with line
   endings normalised to LF, so a Windows checkout does not count as a
   change. Before applying anything, the runner checks every recorded
   migration: its file must exist, its checksum must match, and no pending
   file may sort before the last applied one. Any failure stops the run
   before it changes anything.
3. **Atomicity.** The runner splits each file into statements (respecting
   quotes, dollar quotes and comments) and sends them, followed by the
   insert of the `schema_migrations` row, as one `sql.transaction([...])`.
   A migration is either fully applied and recorded, or not at all. A
   concurrent second runner fails on the `schema_migrations` primary key
   and rolls back. Consequences of this choice:
   - Migration files must not contain `BEGIN`, `COMMIT` or similar; the
     runner rejects them.
   - Statements that cannot run inside a transaction (for example
     `CREATE INDEX CONCURRENTLY`) are not supported. If one is ever needed,
     add a separate mechanism with its own ADR.
   - The alternative, a WebSocket `Pool` on the unpooled URL with a real
     session, was rejected for now: it adds a second connection path to
     `lib/db.ts` that only migrations would use.
4. **Execution.** The runner (`lib/migrations.ts`) works on a small
   `SqlExecutor` interface (`query`, `transaction`) defined in `lib/db.ts`.
   `executor()` in `lib/db.ts` implements it with Neon. `npm run db:migrate`
   runs `scripts/db-migrate.ts` with **tsx** (dev dependency), which runs
   TypeScript directly and resolves the `@/` alias from `tsconfig.json`,
   so the script reuses `lib/config.ts` and `lib/db.ts` unchanged. The
   alternatives were Node's built-in type stripping plus a hand-written
   alias resolver hook (fragile: it needs `import type` everywhere and
   explicit extensions) or a separate build step for scripts. The npm
   script loads `.env.local` if it exists (`--env-file-if-exists`); values
   already in the environment take precedence.
5. **Environment guard.** Without arguments the runner migrates only when
   `config.environment()` is `development`. `--environment=<name>` is
   accepted only when it equals the actual environment; it is how the
   human confirms a Preview or Production migration. Any other argument is
   refused.
6. **Output and errors.** The runner prints the environment and migration
   names only. Errors are fixed messages plus the migration name and, when
   the database reported one, the five-character SQLSTATE. Driver messages
   are never printed (they can contain the connection string).
7. **Testing.** Unit tests run the runner and real SQL on PGlite
   (`@electric-sql/pglite`, dev dependency): Postgres compiled to
   WebAssembly, running in-process with no network. `tests/support/pglite.ts`
   provides an in-memory database that implements `SqlExecutor`, optionally
   with all migrations applied, for later repository tests.
8. **Schema conventions** (from spec 002). ODA mirror tables use the ODA
   `id` as primary key, snake_case ASCII column names (`aktoerid`,
   `afgoerelse`), typed columns for fields we use, and the full source
   record in `raw jsonb`. Mirror tables have no foreign keys to each other,
   because ODA is the source of truth and ingest stores rows in entity order,
   not reference order. Lovvagt's own tables (`tracked_sag`, `fil_blob`)
   reference the mirror rows they describe.

## Consequences

- Schema changes are reviewed as SQL in pull requests, and the checksum
  check catches edits to applied migrations.
- Each migration must fit in one Neon HTTP transaction. Very large data
  migrations should be split into several files or done by ingest code.
- PGlite runs a recent Postgres (18 at the time of writing); Neon runs the
  version chosen for the project. SQL that depends on version-specific
  features should be checked against both.
- PGlite takes a few seconds to start, so tests share one instance per file
  and reset the schema between tests.
- Only the human migrates Preview and Production, with
  `npm run db:migrate -- --environment=<name>` and that environment's
  variables.
