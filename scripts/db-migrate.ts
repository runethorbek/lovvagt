/**
 * `npm run db:migrate [-- --environment=<name>]`
 *
 * Applies pending migrations in `db/migrations/` to the database named by
 * `DATABASE_URL`. Refuses to run unless the environment is `development`,
 * or `--environment` names the actual environment. Prints migration names
 * only: never connection details or driver messages. See ADR 0006.
 *
 * Run with tsx (see package.json), which resolves the `@/` path alias.
 */
import { join } from "node:path";
import { ConfigError, config } from "@/lib/config";
import { executor } from "@/lib/db";
import {
  MigrationError,
  environmentRefusal,
  loadMigrations,
  migrate,
} from "@/lib/migrations";

const directory = join(import.meta.dirname, "..", "db", "migrations");

async function main(): Promise<number> {
  const environment = config.environment();
  const refusal = environmentRefusal(environment, process.argv.slice(2));
  if (refusal) {
    console.error(refusal);
    return 2;
  }

  const migrations = loadMigrations(directory);
  console.log(
    `Migrating the ${environment} database (${migrations.length} migration file(s))`,
  );

  const result = await migrate(executor(), migrations, {
    onApplied: (name) => console.log(`applied ${name}`),
  });

  console.log(
    result.applied.length === 0
      ? `Nothing to apply: ${result.alreadyApplied} migration(s) already applied`
      : `Applied ${result.applied.length}, ${result.alreadyApplied} already applied`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Only our own fixed messages are printed. Anything else could carry
    // driver text, so it is reported generically.
    console.error(
      error instanceof MigrationError || error instanceof ConfigError
        ? error.message
        : "db:migrate failed with an unexpected error",
    );
    process.exitCode = 1;
  },
);
