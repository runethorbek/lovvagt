/**
 * The HTTP layer for Folketingets Åbne Data (ODA): the only code that talks
 * to the ODA API. Everything else uses the typed queries in `lib/oda/`.
 *
 * - Requests are sequential: a module-wide lock lets only one request to ODA
 *   be in flight at a time, even when callers run concurrently.
 * - Each attempt has a timeout. Network errors, timeouts, HTTP 429 and 5xx
 *   are retried with exponential backoff, up to a fixed number of attempts.
 * - The caller's `AbortSignal` stops a request, a backoff wait or paging
 *   at once, and is never retried.
 * - Errors are `OdaError`s with fixed messages. Response bodies and
 *   underlying errors are never passed on, not even as `cause`.
 */
import { z } from "zod";

/** The ODA OData v3 endpoint. No other module may name its host. */
export const odaBaseUrl = "https://oda.ft.dk/api";

/** A generic client name, with no personal contact details. */
export const odaUserAgent = "lovvagt-oda-client/1.0";

/** ODA caps `$top` at 100. */
export const odaMaxTop = 100;

export const odaDefaults = {
  timeoutMs: 30_000,
  maxAttempts: 4,
  retryDelayMs: 1_000,
  maxRetryDelayMs: 15_000,
} as const;

/** Fixed reasons an ODA call can fail with. Never contains response text. */
export const odaFailureReasons = {
  aborted: "aborted",
  timeout: "timed out",
  network: "network error",
  rateLimited: "rate limited",
  serverError: "server error",
  httpError: "unexpected HTTP status",
  invalidJson: "invalid JSON",
  invalidResponse: "invalid response",
  invalidQuery: "invalid query",
  invalidUrl: "invalid URL",
  fileTooLarge: "file too large",
} as const;

export type OdaFailureReason =
  (typeof odaFailureReasons)[keyof typeof odaFailureReasons];

/** Thrown by every ODA function. Its message is always a fixed string. */
export class OdaError extends Error {
  readonly reason: OdaFailureReason;
  /** HTTP status of the last response, if there was one. */
  readonly status: number | undefined;

  constructor(reason: OdaFailureReason, status?: number) {
    super(`ODA request failed: ${reason}`);
    this.name = "OdaError";
    this.reason = reason;
    this.status = status;
  }
}

/** Thrown by `downloadFile()` when a file is larger than the limit. */
export class OdaFileTooLargeError extends OdaError {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(odaFailureReasons.fileTooLarge);
    this.name = "OdaFileTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export type OdaRequestOptions = {
  /** Stops the request (and any paging or retry wait) when aborted. */
  signal?: AbortSignal;
  /** Timeout per attempt, including reading the body. */
  timeoutMs?: number;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  /** Backoff before the first retry; doubles per retry up to a cap. */
  retryDelayMs?: number;
};

// A promise chain that serialises requests across all callers.
let queue: Promise<void> = Promise.resolve();

async function withLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>((resolve) => (release = resolve));
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OdaError(odaFailureReasons.aborted));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OdaError(odaFailureReasons.aborted));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Discards a body we will not read, so the connection can be reused. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to do: the body is not needed.
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function statusError(status: number): OdaError {
  if (status === 429)
    return new OdaError(odaFailureReasons.rateLimited, status);
  if (status >= 500) return new OdaError(odaFailureReasons.serverError, status);
  return new OdaError(odaFailureReasons.httpError, status);
}

/**
 * GETs `url` and passes the successful response to `read`, which must
 * consume the body. Runs under the lock, with a timeout per attempt and
 * retries as described above. `read` may throw an `OdaError`, which is not
 * retried; other errors thrown while reading count as network errors.
 */
export async function odaRequest<T>(
  url: string,
  read: (response: Response) => Promise<T>,
  options: OdaRequestOptions = {},
  accept = "application/json",
): Promise<T> {
  const {
    signal,
    timeoutMs = odaDefaults.timeoutMs,
    maxAttempts = odaDefaults.maxAttempts,
    retryDelayMs = odaDefaults.retryDelayMs,
  } = options;

  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw new OdaError(odaFailureReasons.aborted);

    let failure: OdaError;
    // Created under the lock, so waiting for another request does not use
    // up this attempt's time.
    let timeout: AbortSignal | undefined;
    try {
      return await withLock(async () => {
        if (signal?.aborted) throw new OdaError(odaFailureReasons.aborted);
        timeout = AbortSignal.timeout(timeoutMs);
        const attemptSignal = signal
          ? AbortSignal.any([signal, timeout])
          : timeout;
        const response = await fetch(url, {
          headers: { Accept: accept, "User-Agent": odaUserAgent },
          redirect: "follow",
          signal: attemptSignal,
        });
        if (!response.ok) {
          await discard(response);
          throw statusError(response.status);
        }
        return await read(response);
      });
    } catch (error) {
      if (signal?.aborted) throw new OdaError(odaFailureReasons.aborted);
      if (error instanceof OdaError) {
        if (error.status === undefined || !isRetryableStatus(error.status))
          throw error;
        failure = error;
      } else if (timeout?.aborted) {
        failure = new OdaError(odaFailureReasons.timeout);
      } else {
        failure = new OdaError(odaFailureReasons.network);
      }
    }

    if (attempt >= maxAttempts) throw failure;
    await sleep(
      Math.min(retryDelayMs * 2 ** (attempt - 1), odaDefaults.maxRetryDelayMs),
      signal,
    );
  }
}

/** Query options for an ODA entity set. Values are plain OData syntax. */
export type OdaQuery = {
  /** `$filter`, e.g. `typeid eq 3 and periodeid eq 163`. */
  filter?: string;
  /** `$expand`, e.g. `Dokument/Fil`. */
  expand?: string;
  /** `$orderby`, e.g. `opdateringsdato`. */
  orderby?: string;
  /** `$top` per page, at most 100. Paging still follows `odata.nextLink`. */
  top?: number;
};

// Percent-encodes a query value, keeping characters that are safe in a
// query string readable.
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("%2F", "/")
    .replaceAll("%2C", ",")
    .replaceAll("%3A", ":");
}

/**
 * Builds the URL of the first page of an entity set query. The entity name
 * (e.g. `SagAktør`) and all values are percent-encoded; `$format=json` is
 * always added.
 */
export function odaQueryUrl(entity: string, query: OdaQuery = {}): string {
  const { top } = query;
  if (
    top !== undefined &&
    (!Number.isInteger(top) || top < 1 || top > odaMaxTop)
  )
    throw new OdaError(odaFailureReasons.invalidQuery);
  const params: string[] = [];
  if (query.filter !== undefined)
    params.push(`$filter=${encodeQueryValue(query.filter)}`);
  if (query.expand !== undefined)
    params.push(`$expand=${encodeQueryValue(query.expand)}`);
  if (query.orderby !== undefined)
    params.push(`$orderby=${encodeQueryValue(query.orderby)}`);
  if (top !== undefined) params.push(`$top=${top}`);
  params.push("$format=json");
  return `${odaBaseUrl}/${encodeURIComponent(entity)}?${params.join("&")}`;
}

/**
 * Checks that an `odata.nextLink` points back at the ODA API and asks for
 * JSON. Returns the URL to request next.
 */
function nextPageUrl(link: string): string {
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    throw new OdaError(odaFailureReasons.invalidResponse);
  }
  const base = new URL(odaBaseUrl);
  if (
    parsed.origin !== base.origin ||
    !parsed.pathname.startsWith(`${base.pathname}/`)
  ) {
    throw new OdaError(odaFailureReasons.invalidResponse);
  }
  if (/[?&]\$format=json(&|$)/.test(parsed.search)) return link;
  return `${link}${parsed.search ? "&" : "?"}$format=json`;
}

const pageSchema = z.object({
  value: z.array(z.unknown()),
  "odata.nextLink": z.string().optional(),
});

/** Reads a response body as JSON. Invalid JSON is a fixed error. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new OdaError(odaFailureReasons.invalidJson);
  }
}

/**
 * Fetches an entity set page by page, following `odata.nextLink` until the
 * last page. Each row is validated with `parse`, which returns `undefined`
 * for an invalid row; any invalid row fails the whole page.
 */
export async function* odaPages<T>(
  entity: string,
  query: OdaQuery,
  parse: (row: unknown) => T | undefined,
  options: OdaRequestOptions = {},
): AsyncGenerator<T[], void, undefined> {
  let url: string | undefined = odaQueryUrl(entity, query);
  const seen = new Set<string>();
  while (url !== undefined) {
    if (seen.has(url)) throw new OdaError(odaFailureReasons.invalidResponse);
    seen.add(url);

    const body = await odaRequest(url, readJson, options);
    const page = pageSchema.safeParse(body);
    if (!page.success) throw new OdaError(odaFailureReasons.invalidResponse);
    const rows = page.data.value.map((row) => {
      const parsed = parse(row);
      if (parsed === undefined)
        throw new OdaError(odaFailureReasons.invalidResponse);
      return parsed;
    });
    yield rows;

    const link = page.data["odata.nextLink"];
    url = link === undefined ? undefined : nextPageUrl(link);
  }
}

/** Fetches all pages of an entity set query into one array. */
export async function odaFetchAll<T>(
  entity: string,
  query: OdaQuery,
  parse: (row: unknown) => T | undefined,
  options: OdaRequestOptions = {},
): Promise<T[]> {
  const rows: T[] = [];
  for await (const page of odaPages(entity, query, parse, options))
    rows.push(...page);
  return rows;
}
