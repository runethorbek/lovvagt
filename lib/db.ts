/**
 * The one module that accesses the database.
 *
 * All other code gets its database client from here. The client uses the
 * Neon serverless driver over HTTP with the pooled `DATABASE_URL`, read
 * through `lib/config.ts`.
 */
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { config } from "@/lib/config";
import { fingerprint } from "@/lib/fingerprint";

/** Creates a Neon query function for the pooled `DATABASE_URL`. */
export function db(): NeonQueryFunction<false, false> {
  return neon(config.database().url);
}

/** One SQL statement with `$1`-style placeholders. */
export type SqlStatement = { text: string; params?: unknown[] };

/**
 * A minimal SQL interface that both Neon (here) and the PGlite test harness
 * (`tests/support/pglite.ts`) implement, so SQL can be tested without a
 * network connection.
 *
 * - `query` runs one statement and returns its rows.
 * - `transaction` runs the statements, in order, in a single transaction:
 *   either all of them take effect or none do. It is non-interactive (the
 *   statements are fixed up front), because that is what Neon's HTTP driver
 *   supports.
 *
 * Errors are the driver's own. Callers must not pass their messages on.
 */
export interface SqlExecutor {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  transaction(statements: readonly SqlStatement[]): Promise<void>;
}

/** A `SqlExecutor` for the pooled `DATABASE_URL`, over Neon's HTTP driver. */
export function executor(): SqlExecutor {
  const sql = db();
  return {
    async query(text, params) {
      return sql.query(text, params ?? []);
    },
    async transaction(statements) {
      await sql.transaction(
        statements.map(({ text, params }) => sql.query(text, params ?? [])),
      );
    },
  };
}

/**
 * Fixed error messages. Driver errors can contain the connection string,
 * host, user or password, so their text is never passed through.
 */
export const databaseErrors = {
  configuration: "configuration missing or invalid",
  connectionString: "invalid connection string",
  connection: "connection failed",
  authentication: "authentication failed",
  query: "query failed",
  unexpectedResult: "unexpected result",
} as const;

export type DatabaseError =
  (typeof databaseErrors)[keyof typeof databaseErrors];

export type DatabaseCheck =
  | { ok: true; latencyMs: number; fingerprint: string }
  | { ok: false; latencyMs: number; error: DatabaseError };

/**
 * The exact fingerprint input: `${host}/${database}`, where `host` is the
 * lowercase host name without port (the pooled host, so it includes
 * `-pooler` on Neon) and `database` is the decoded path of the connection
 * string without the leading slash. Exported for tests and documentation.
 */
export function fingerprintInput(connectionString: string): string {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) throw new Error("incomplete");
  return `${url.hostname.toLowerCase()}/${database}`;
}

const sqlState = /^[0-9A-Z]{5}$/;

// Matched against the driver message only to classify it; the message itself
// is never returned, logged or attached.
const authenticationMessage =
  /password authentication failed|authentication failed|invalid password/i;

/**
 * Maps a driver error to a fixed message. Postgres errors carry a
 * five-character SQLSTATE code; class `28` is an authorisation failure.
 * Over HTTP, Neon reports a wrong password with an empty `code`, so an error
 * without a valid code is an authentication failure if its message says so,
 * and a connection failure (network errors, timeouts) otherwise.
 */
function classifyQueryError(error: unknown): DatabaseError {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (sqlState.test(code)) {
    return code.startsWith("28")
      ? databaseErrors.authentication
      : databaseErrors.query;
  }
  const message = error instanceof Error ? error.message : "";
  return authenticationMessage.test(message)
    ? databaseErrors.authentication
    : databaseErrors.connection;
}

/**
 * Runs `SELECT 1` and returns its latency and a fingerprint of the database.
 * Never throws, and never returns any part of the connection string.
 */
export async function checkDatabase(): Promise<DatabaseCheck> {
  const start = performance.now();
  const fail = (error: DatabaseError): DatabaseCheck => ({
    ok: false,
    latencyMs: Math.round(performance.now() - start),
    error,
  });

  let url: string;
  try {
    url = config.database().url;
  } catch {
    return fail(databaseErrors.configuration);
  }

  let id: string;
  let sql: NeonQueryFunction<false, false>;
  try {
    id = fingerprint(fingerprintInput(url));
    sql = neon(url);
  } catch {
    return fail(databaseErrors.connectionString);
  }

  let rows: Record<string, unknown>[];
  try {
    rows = await sql`SELECT 1 AS ok`;
  } catch (error) {
    return fail(classifyQueryError(error));
  }

  if (rows.length !== 1 || rows[0]?.ok !== 1) {
    return fail(databaseErrors.unexpectedResult);
  }

  return {
    ok: true,
    latencyMs: Math.round(performance.now() - start),
    fingerprint: id,
  };
}
