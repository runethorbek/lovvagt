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

/**
 * Fixed error messages. Driver errors can contain the connection string,
 * host, user or password, so their text is never passed through.
 */
export const databaseErrors = {
  configuration: "configuration missing or invalid",
  connectionString: "invalid connection string",
  connection: "connection failed",
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
    // An error reported by Postgres carries a five-character SQLSTATE code;
    // anything else (network errors, timeouts) is a connection failure.
    const isQueryError =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[0-9A-Z]{5}$/.test(error.code);
    return fail(
      isQueryError ? databaseErrors.query : databaseErrors.connection,
    );
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
