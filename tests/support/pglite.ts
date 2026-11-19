/**
 * SQL test harness: a real Postgres engine (PGlite, Postgres compiled to
 * WebAssembly) running in-process, with no network access. It implements
 * `SqlExecutor`, so code written against `lib/db.ts` can be tested on it.
 *
 * Starting PGlite takes a few seconds, so create one database per test file
 * (`beforeAll`) and call `reset()` between tests that need a clean schema.
 */
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "@/lib/db";
import { loadMigrations, migrate } from "@/lib/migrations";

export const migrationsDirectory = join(
  import.meta.dirname,
  "..",
  "..",
  "db",
  "migrations",
);

export type TestDatabase = {
  /** The executor to pass to code under test. */
  sql: SqlExecutor;
  /** The PGlite instance, for assertions that need more than the executor. */
  pg: PGlite;
  /** Drops and recreates the public schema, removing every table. */
  reset(): Promise<void>;
  close(): Promise<void>;
};

/** Wraps a PGlite instance as a `SqlExecutor`. */
export function pgliteExecutor(pg: PGlite): SqlExecutor {
  return {
    async query(text, params) {
      const result = await pg.query<Record<string, unknown>>(
        text,
        params ?? [],
      );
      return result.rows;
    },
    async transaction(statements) {
      await pg.transaction(async (tx) => {
        for (const { text, params } of statements) {
          await tx.query(text, params ?? []);
        }
      });
    },
  };
}

/** An empty in-memory database. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = await PGlite.create();
  return {
    sql: pgliteExecutor(pg),
    pg,
    async reset() {
      await pg.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    },
    close: () => pg.close(),
  };
}

/** An in-memory database with every migration in `db/migrations/` applied. */
export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  await migrate(database.sql, loadMigrations(migrationsDirectory));
  return database;
}
