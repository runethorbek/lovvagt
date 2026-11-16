/**
 * The one module that accesses Vercel Blob.
 *
 * All other code stores and reads objects through these functions. Every SDK
 * call gets `storeId` and `oidcToken` passed explicitly from `blobConfig()`,
 * so the SDK's own environment lookup (and any read-write token it might
 * find) is never used. All objects are private. See ADR 0004.
 *
 * SDK error messages are never passed on: they are mapped to fixed messages,
 * so no token, URL or store detail can leak through them.
 */
import {
  BlobAccessError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
  BlobRequestAbortedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  del,
  get,
  list,
  put,
} from "@vercel/blob";
import { fingerprint } from "@/lib/fingerprint";
import {
  blobConfig,
  blobStoreIdVariable,
  type BlobConfig,
  type BlobStoreIdVariable,
} from "@/lib/blob/config";

/** What `putObject` accepts as a body (the SDK does not export this type). */
export type PutBody = Parameters<typeof put>[1];

export type BlobOperation = "put" | "get" | "delete" | "list";

/** Fixed reasons an operation can fail with. Never contains SDK text. */
export const blobFailureReasons = {
  accessDenied: "access denied",
  storeNotFound: "store not found",
  storeSuspended: "store suspended",
  notFound: "object not found",
  alreadyExists: "object already exists or changed",
  rateLimited: "rate limited",
  unavailable: "service unavailable",
  aborted: "request aborted",
  unexpectedResponse: "unexpected response",
  unknown: "request failed",
} as const;

export type BlobFailureReason =
  (typeof blobFailureReasons)[keyof typeof blobFailureReasons];

/** Thrown by the operations below. Its message is always a fixed string. */
export class BlobOperationError extends Error {
  readonly operation: BlobOperation;
  readonly reason: BlobFailureReason;

  constructor(operation: BlobOperation, reason: BlobFailureReason) {
    super(`blob ${operation} failed: ${reason}`);
    this.name = "BlobOperationError";
    this.operation = operation;
    this.reason = reason;
  }
}

/** Maps any thrown value to a fixed reason. The original is discarded. */
function reasonFor(error: unknown): BlobFailureReason {
  if (error instanceof BlobAccessError) return blobFailureReasons.accessDenied;
  if (error instanceof BlobStoreNotFoundError)
    return blobFailureReasons.storeNotFound;
  if (error instanceof BlobStoreSuspendedError)
    return blobFailureReasons.storeSuspended;
  if (error instanceof BlobNotFoundError) return blobFailureReasons.notFound;
  if (error instanceof BlobPreconditionFailedError)
    return blobFailureReasons.alreadyExists;
  if (error instanceof BlobServiceRateLimited)
    return blobFailureReasons.rateLimited;
  if (error instanceof BlobServiceNotAvailable)
    return blobFailureReasons.unavailable;
  if (error instanceof BlobRequestAbortedError)
    return blobFailureReasons.aborted;
  return blobFailureReasons.unknown;
}

/**
 * Runs one SDK call with explicit credentials. A `ConfigError` from
 * `blobConfig()` (which only names variables) propagates as is; everything else becomes a
 * `BlobOperationError` with a fixed message and no `cause`.
 */
async function run<T>(
  operation: BlobOperation,
  call: (auth: Pick<BlobConfig, "storeId" | "oidcToken">) => Promise<T>,
): Promise<T> {
  const { storeId, oidcToken } = blobConfig();
  try {
    return await call({ storeId, oidcToken });
  } catch (error) {
    if (error instanceof BlobOperationError) throw error;
    throw new BlobOperationError(operation, reasonFor(error));
  }
}

export type BlobObjectInfo = {
  pathname: string;
  size: number;
  uploadedAt: Date;
};

export type PutObjectOptions = {
  contentType?: string;
  /** Replace an existing object at the same pathname. Default `false`. */
  allowOverwrite?: boolean;
};

/** Writes a private object at exactly `pathname` (no random suffix). */
export async function putObject(
  pathname: string,
  body: PutBody,
  options: PutObjectOptions = {},
): Promise<{ pathname: string }> {
  return run("put", async (auth) => {
    const result = await put(pathname, body, {
      ...auth,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: options.allowOverwrite ?? false,
      ...(options.contentType ? { contentType: options.contentType } : {}),
    });
    return { pathname: result.pathname };
  });
}

export type GetObjectOptions = {
  /** `false` reads from origin, bypassing the CDN cache. Default `true`. */
  useCache?: boolean;
};

/** Reads a private object. Returns `null` if it does not exist. */
export async function getObject(
  pathname: string,
  options: GetObjectOptions = {},
): Promise<{ pathname: string; contentType: string; body: Uint8Array } | null> {
  return run("get", async (auth) => {
    const result = await get(pathname, {
      ...auth,
      access: "private",
      useCache: options.useCache ?? true,
    });
    if (result === null) return null;
    if (result.statusCode !== 200) {
      throw new BlobOperationError(
        "get",
        blobFailureReasons.unexpectedResponse,
      );
    }
    const body = new Uint8Array(
      await new Response(result.stream).arrayBuffer(),
    );
    return {
      pathname: result.blob.pathname,
      contentType: result.blob.contentType,
      body,
    };
  });
}

/** Deletes one or more objects. Deleting a missing object is not an error. */
export async function deleteObject(pathname: string | string[]): Promise<void> {
  await run("delete", (auth) => del(pathname, auth));
}

export type ListObjectsOptions = {
  /** Continue from the `cursor` of a previous page. */
  cursor?: string;
  /** Page size. The SDK default is 1000. */
  limit?: number;
};

/** Lists one page of objects whose pathname starts with `prefix`. */
export async function listObjects(
  prefix: string,
  options: ListObjectsOptions = {},
): Promise<{ objects: BlobObjectInfo[]; cursor?: string; hasMore: boolean }> {
  return run("list", async (auth) => {
    const result = await list({
      ...auth,
      prefix,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    });
    return {
      objects: result.blobs.map(({ pathname, size, uploadedAt }) => ({
        pathname,
        size,
        uploadedAt,
      })),
      ...(result.cursor ? { cursor: result.cursor } : {}),
      hasMore: result.hasMore,
    };
  });
}

/** The probe object written and removed by `checkBlob()`. */
export const probe = {
  pathname: "healthcheck/probe.txt",
  content: "lovvagt blob health check probe v1",
  contentType: "text/plain",
} as const;

/** Fixed error messages returned by `checkBlob()`. */
export const blobCheckErrors = {
  configuration: "configuration missing or invalid",
  put: "write failed",
  get: "read failed",
  missing: "read-back object missing",
  mismatch: "read-back content mismatch",
  delete: "delete failed",
} as const;

export type BlobCheckError =
  (typeof blobCheckErrors)[keyof typeof blobCheckErrors];

export type BlobCheck =
  | {
      ok: true;
      latencyMs: number;
      storeIdVariable: BlobStoreIdVariable;
      fingerprint: string;
    }
  | {
      ok: false;
      latencyMs: number;
      /** `null` only when the environment itself could not be resolved. */
      storeIdVariable: BlobStoreIdVariable | null;
      error: BlobCheckError;
    };

/**
 * Writes the probe object, reads it back, compares the content and deletes
 * it. The delete is attempted whatever happened before. Returns latency, the
 * name of the store ID variable and a fingerprint of the store ID. Never
 * throws, and never returns the token or the store ID itself.
 *
 * The fingerprint is `fingerprint(storeId)`, where `storeId` is the trimmed
 * value of the variable including its `store_` prefix.
 */
export async function checkBlob(): Promise<BlobCheck> {
  const start = performance.now();
  const latencyMs = () => Math.round(performance.now() - start);

  let storeIdVariable: BlobStoreIdVariable | null = null;
  let storeId: string;
  try {
    storeIdVariable = blobStoreIdVariable();
    storeId = blobConfig().storeId;
  } catch {
    return {
      ok: false,
      latencyMs: latencyMs(),
      storeIdVariable,
      error: blobCheckErrors.configuration,
    };
  }

  let error: BlobCheckError | null = null;
  try {
    await putObject(probe.pathname, probe.content, {
      contentType: probe.contentType,
      allowOverwrite: true,
    });
    try {
      const object = await getObject(probe.pathname, { useCache: false });
      if (object === null) {
        error = blobCheckErrors.missing;
      } else if (new TextDecoder().decode(object.body) !== probe.content) {
        error = blobCheckErrors.mismatch;
      }
    } catch {
      error = blobCheckErrors.get;
    }
  } catch {
    error = blobCheckErrors.put;
  }

  try {
    await deleteObject(probe.pathname);
  } catch {
    // An earlier failure is the more useful error to report.
    error ??= blobCheckErrors.delete;
  }

  if (error !== null) {
    return { ok: false, latencyMs: latencyMs(), storeIdVariable, error };
  }
  return {
    ok: true,
    latencyMs: latencyMs(),
    storeIdVariable,
    fingerprint: fingerprint(storeId),
  };
}
