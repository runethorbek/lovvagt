/**
 * Schema migrations: plain SQL files in `db/migrations/`, applied in order and
 * tracked in `schema_migrations`. See ADR 0006.
 *
 * The runner works on any `SqlExecutor`, so it runs against Neon through
 * `lib/db.ts` (`npm run db:migrate`) and against PGlite in unit tests.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { environments, type Environment } from "@/lib/config";
import type { SqlExecutor } from "@/lib/db";

/** A migration file, parsed and ready to apply. */
export type Migration = {
  /** File name without `.sql`, e.g. `0001_initial`. */
  name: string;
  /** SHA-256 (hex) of the file content with line endings normalised to LF. */
  checksum: string;
  /** The file's statements, in order, without the separating semicolons. */
  statements: string[];
};

/** Fixed error messages. Driver messages are never included. */
export const migrationErrors = {
  invalidFileName: "migration file name must match NNNN_short_name.sql",
  duplicateNumber: "two migration files share a number",
  empty: "migration file contains no statements",
  transactionControl:
    "migration file must not control transactions (the runner wraps each file in one)",
  unterminated:
    "migration file has an unterminated string, identifier or comment",
  bookkeeping: "could not read or create schema_migrations",
  missingFile: "an applied migration has no file",
  checksumMismatch: "an applied migration's file has changed",
  outOfOrder: "a pending migration sorts before an applied migration",
  failed: "migration failed",
} as const;

export type MigrationErrorMessage =
  (typeof migrationErrors)[keyof typeof migrationErrors];

/**
 * A migration failure. `migration` is the file name (ours, safe to show).
 * `sqlState` is the five-character Postgres error code when the database
 * reported one; it identifies the kind of error without its message.
 */
export class MigrationError extends Error {
  readonly migration: string | undefined;
  readonly sqlState: string | undefined;

  constructor(
    message: MigrationErrorMessage,
    options: { migration?: string; sqlState?: string } = {},
  ) {
    const details = [
      options.migration && `migration ${options.migration}`,
      options.sqlState && `SQLSTATE ${options.sqlState}`,
    ].filter(Boolean);
    super(details.length > 0 ? `${message} (${details.join(", ")})` : message);
    this.name = "MigrationError";
    this.migration = options.migration;
    this.sqlState = options.sqlState;
  }
}

const fileNamePattern = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const sqlStatePattern = /^[0-9A-Z]{5}$/;
const transactionControlPattern =
  /^(begin|commit|rollback|end|abort|savepoint|release|start\s+transaction)\b/i;

/** Returns the SQLSTATE of a driver error, or undefined. Never reads the message. */
function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" && sqlStatePattern.test(code)
    ? code
    : undefined;
}

/** SHA-256 (hex) of `content`, with CRLF normalised to LF. */
export function checksum(content: string): string {
  return createHash("sha256")
    .update(content.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

/**
 * Splits a SQL script into statements on top-level semicolons. Semicolons
 * inside quoted strings (including `E'...'` escapes), quoted identifiers,
 * dollar-quoted bodies and comments do not split. Statements that contain
 * only whitespace and comments are dropped.
 *
 * Needed because Neon's HTTP driver runs one statement per query.
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let hasCode = false;
  let i = 0;

  const push = (end: number) => {
    const text = script.slice(start, end).trim();
    if (hasCode) statements.push(text);
    hasCode = false;
  };

  const unterminated = () => new MigrationError(migrationErrors.unterminated);

  while (i < script.length) {
    const char = script[i];
    const next = script[i + 1];

    if (char === "-" && next === "-") {
      const end = script.indexOf("\n", i);
      i = end === -1 ? script.length : end + 1;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= script.length) throw unterminated();
        if (script[i] === "/" && script[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (script[i] === "*" && script[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
    } else if (char === "'") {
      const previous = script[i - 1];
      const escapes =
        (previous === "E" || previous === "e") &&
        !/[A-Za-z0-9_]/.test(script[i - 2] ?? "");
      hasCode = true;
      i++;
      for (;;) {
        if (i >= script.length) throw unterminated();
        if (escapes && script[i] === "\\") {
          i += 2;
        } else if (script[i] === "'") {
          i++;
          // A doubled quote is an escaped quote inside the string.
          if (script[i] === "'") i++;
          else break;
        } else {
          i++;
        }
      }
    } else if (char === '"') {
      hasCode = true;
      const end = script.indexOf('"', i + 1);
      if (end === -1) throw unterminated();
      i = end + 1;
    } else if (char === "$" && !/[A-Za-z0-9_]/.test(script[i - 1] ?? "")) {
      // A dollar quote is `$tag$` with an optional tag that does not start
      // with a digit; `$1` is a parameter placeholder, not a quote.
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i));
      hasCode = true;
      if (tag) {
        const end = script.indexOf(tag[0], i + tag[0].length);
        if (end === -1) throw unterminated();
        i = end + tag[0].length;
      } else {
        i++;
      }
    } else if (char === ";") {
      push(i);
      i++;
      start = i;
    } else {
      if (!/\s/.test(char)) hasCode = true;
      i++;
    }
  }
  push(script.length);
  return statements;
}

/** Parses one migration file's content. */
export function parseMigration(name: string, content: string): Migration {
  let statements: string[];
  try {
    statements = splitStatements(content);
  } catch {
    throw new MigrationError(migrationErrors.unterminated, { migration: name });
  }
  if (statements.length === 0) {
    throw new MigrationError(migrationErrors.empty, { migration: name });
  }
  if (
    statements.some((statement) => transactionControlPattern.test(statement))
  ) {
    throw new MigrationError(migrationErrors.transactionControl, {
      migration: name,
    });
  }
  return { name, checksum: checksum(content), statements };
}

/**
 * Reads every `.sql` file in `directory`, sorted by name. Any `.sql` file
 * whose name does not match `NNNN_short_name.sql`, or that shares its number
 * with another file, is an error rather than silently skipped.
 */
export function loadMigrations(directory: string): Migration[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const numbers = new Set<string>();
  return files.map((file) => {
    const name = file.slice(0, -".sql".length);
    const match = fileNamePattern.exec(file);
    if (!match) {
      throw new MigrationError(migrationErrors.invalidFileName, {
        migration: name,
      });
    }
    if (numbers.has(match[1])) {
      throw new MigrationError(migrationErrors.duplicateNumber, {
        migration: name,
      });
    }
    numbers.add(match[1]);
    return parseMigration(name, readFileSync(join(directory, file), "utf8"));
  });
}

const createBookkeeping = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export type MigrateResult = {
  /** Names of the migrations applied by this run, in order. */
  applied: string[];
  /** Number of migrations that were already applied. */
  alreadyApplied: number;
};

/**
 * Applies pending migrations in name order. Each migration runs in its own
 * transaction together with the insert of its `schema_migrations` row, so a
 * migration is either fully applied and recorded or not at all.
 *
 * Before applying anything, it checks every applied migration: its file must
 * still exist with the same checksum, and no pending migration may sort
 * before it. Throws `MigrationError`; driver errors are reduced to their
 * SQLSTATE.
 */
export async function migrate(
  sql: SqlExecutor,
  migrations: readonly Migration[],
  options: { onApplied?: (name: string) => void } = {},
): Promise<MigrateResult> {
  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name));

  let rows: Record<string, unknown>[];
  try {
    await sql.query(createBookkeeping);
    rows = await sql.query(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
  } catch (error) {
    throw new MigrationError(migrationErrors.bookkeeping, {
      sqlState: sqlStateOf(error),
    });
  }

  const applied = new Map(
    rows.map((row) => [String(row.name), String(row.checksum)]),
  );
  const byName = new Map(
    ordered.map((migration) => [migration.name, migration]),
  );

  for (const [name, recorded] of applied) {
    const migration = byName.get(name);
    if (!migration) {
      throw new MigrationError(migrationErrors.missingFile, {
        migration: name,
      });
    }
    if (migration.checksum !== recorded) {
      throw new MigrationError(migrationErrors.checksumMismatch, {
        migration: name,
      });
    }
  }

  const pending = ordered.filter((migration) => !applied.has(migration.name));
  const lastApplied = [...applied.keys()].sort().at(-1);
  const early = pending.find(
    (migration) =>
      lastApplied !== undefined &&
      migration.name.localeCompare(lastApplied) < 0,
  );
  if (early) {
    throw new MigrationError(migrationErrors.outOfOrder, {
      migration: early.name,
    });
  }

  const done: string[] = [];
  for (const migration of pending) {
    try {
      await sql.transaction([
        ...migration.statements.map((text) => ({ text })),
        {
          text: "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          params: [migration.name, migration.checksum],
        },
      ]);
    } catch (error) {
      throw new MigrationError(migrationErrors.failed, {
        migration: migration.name,
        sqlState: sqlStateOf(error),
      });
    }
    done.push(migration.name);
    options.onApplied?.(migration.name);
  }

  return { applied: done, alreadyApplied: applied.size };
}

/**
 * Decides whether `npm run db:migrate` may run. Returns undefined when it may,
 * or a fixed reason when it must refuse.
 *
 * Without a flag it runs only when the actual environment is `development`.
 * `--environment=<name>` must name the actual environment exactly; it is how
 * the human confirms a Preview or Production migration. Any other argument
 * is refused.
 */
export function environmentRefusal(
  actual: Environment,
  args: readonly string[],
): string | undefined {
  let flag: string | undefined;
  for (const arg of args) {
    const match = /^--environment=(.*)$/.exec(arg);
    if (!match || flag !== undefined) {
      return "usage: npm run db:migrate [-- --environment=<production|preview|development>]";
    }
    flag = match[1];
  }

  if (flag === undefined) {
    return actual === "development"
      ? undefined
      : `refusing to migrate the ${actual} database without --environment=${actual}`;
  }
  if (!(environments as readonly string[]).includes(flag)) {
    return "--environment must be production, preview or development";
  }
  if (flag !== actual) {
    return `--environment=${flag} does not match the actual environment (${actual})`;
  }
  return undefined;
}
