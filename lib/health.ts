/**
 * The health check behind `GET /api/health` (spec 001, deliverable 5).
 *
 * `isAuthorised()` checks the bearer secret; `runHealthChecks()` runs the
 * database, blob and Gemini checks in parallel, each with a timeout. Neither
 * returns or logs any secret: the checks only return fixed error strings,
 * fingerprints and variable or model names.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { checkBlob, type BlobCheck } from "@/lib/blob";
import { blobStoreIdVariable } from "@/lib/blob/config";
import { config, type Environment } from "@/lib/config";
import { checkDatabase, type DatabaseCheck } from "@/lib/db";
import { checkGemini, models, type GeminiCheck } from "@/lib/model";

/**
 * Per-check timeout. The checks run in parallel, so the endpoint answers in
 * about this time at worst, well under the Vercel Hobby function limit.
 */
export const checkTimeoutMs = 10_000;

/** Fixed errors added by this module on top of each check's own errors. */
export const healthErrors = {
  timeout: "timeout",
  unexpected: "check failed",
} as const;

type HealthError = (typeof healthErrors)[keyof typeof healthErrors];

/** A check's failed result, but with an error added by this module. */
type WithHealthError<T> = Omit<Extract<T, { ok: false }>, "error"> & {
  error: HealthError;
};

export type HealthChecks = {
  database: DatabaseCheck | WithHealthError<DatabaseCheck>;
  blob: BlobCheck | WithHealthError<BlobCheck>;
  gemini: GeminiCheck | WithHealthError<GeminiCheck>;
};

export type HealthReport = {
  /** `null` only if `VERCEL_ENV` holds an unknown value. */
  environment: Environment | null;
  ok: boolean;
  checks: HealthChecks;
};

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * True if `authorization` is `Bearer <CRON_SECRET>`. Fails closed: a missing
 * or empty `CRON_SECRET` rejects every request. The secret is compared in
 * constant time on SHA-256 digests, which are always of equal length, so
 * neither the content nor the length of the secret leaks through timing.
 */
export function isAuthorised(authorization: string | null): boolean {
  let secret: string;
  try {
    secret = config.cronSecret();
  } catch {
    return false;
  }
  if (authorization === null) return false;

  const match = /^Bearer (.+)$/i.exec(authorization);
  if (!match) return false;
  return timingSafeEqual(sha256(match[1] as string), sha256(secret));
}

/**
 * Resolves with `check()`'s result, or with `onFailure(error)` if it does not
 * settle within `timeoutMs` or rejects. The checks never reject, but a bug
 * must not turn into an unhandled error or a hanging request.
 */
async function withTimeout<T>(
  check: () => Promise<T>,
  onFailure: (error: HealthError, latencyMs: number) => T,
  timeoutMs: number,
): Promise<T> {
  const start = performance.now();
  const latencyMs = () => Math.round(performance.now() - start);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(
      () => resolve(onFailure(healthErrors.timeout, latencyMs())),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      check().catch(() => onFailure(healthErrors.unexpected, latencyMs())),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeEnvironment(): Environment | null {
  try {
    return config.environment();
  } catch {
    return null;
  }
}

function safeStoreIdVariable() {
  try {
    return blobStoreIdVariable();
  } catch {
    return null;
  }
}

/** Runs the three checks in parallel, each limited to `timeoutMs`. */
export async function runHealthChecks(
  timeoutMs: number = checkTimeoutMs,
): Promise<HealthReport> {
  const [database, blob, gemini] = await Promise.all([
    withTimeout<HealthChecks["database"]>(
      checkDatabase,
      (error, latencyMs) => ({ ok: false, latencyMs, error }),
      timeoutMs,
    ),
    withTimeout<HealthChecks["blob"]>(
      checkBlob,
      (error, latencyMs) => ({
        ok: false,
        latencyMs,
        storeIdVariable: safeStoreIdVariable(),
        error,
      }),
      timeoutMs,
    ),
    withTimeout<HealthChecks["gemini"]>(
      checkGemini,
      (error, latencyMs) => ({
        ok: false,
        latencyMs,
        model: models.healthcheck,
        error,
      }),
      timeoutMs,
    ),
  ]);

  const environment = safeEnvironment();
  return {
    environment,
    ok: environment !== null && database.ok && blob.ok && gemini.ok,
    checks: { database, blob, gemini },
  };
}
