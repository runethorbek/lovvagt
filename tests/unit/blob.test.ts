/**
 * Tests for the blob helper (`lib/blob/`). This file is allow-listed in
 * `boundaries.test.ts` to name the blob variables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The SDK functions are mocked: no test in this file may reach Vercel Blob.
// The real error classes are kept, so error mapping is tested against them.
const sdk = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/blob")>()),
  ...sdk,
}));

const blob = await import("@/lib/blob");
const { blobConfig } = await import("@/lib/blob/config");
const { ConfigError } = await import("@/lib/config");
const { fingerprint } = await import("@/lib/fingerprint");
const { BlobAccessError, BlobError, BlobServiceRateLimited } =
  await import("@vercel/blob");

const prodStoreId = "store_ProdSecret123";
const devStoreId = "store_DevSecret456";
const oidcToken = "eyJ.oidc-token-secret-789.sig";

/** Every value that must never appear in a result or error. */
const sensitive = [oidcToken, "oidc-token-secret-789"];

function expectNoSecrets(value: unknown) {
  const text =
    value instanceof Error
      ? `${value.message} ${String(value.stack)} ${JSON.stringify(value)} ${String(value.cause)}`
      : JSON.stringify(value);
  for (const secret of sensitive) expect(text).not.toContain(secret);
}

/** An SDK error whose message contains the token. */
function leakyError() {
  return new BlobError(`request with Bearer ${oidcToken} failed`);
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

function found(content: string) {
  return {
    statusCode: 200,
    stream: streamOf(content),
    headers: new Headers(),
    blob: { pathname: blob.probe.pathname, contentType: "text/plain" },
  };
}

/** Makes the SDK behave like a working store. */
function healthyStore() {
  sdk.put.mockResolvedValue({ pathname: blob.probe.pathname });
  sdk.get.mockImplementation(async () => found(blob.probe.content));
  sdk.del.mockResolvedValue(undefined);
}

function useEnvironment(vercelEnv: string | undefined) {
  vi.stubEnv("VERCEL_ENV", vercelEnv);
  vi.stubEnv("BLOB_STORE_ID", prodStoreId);
  vi.stubEnv("DEV_BLOB_STORE_ID", devStoreId);
  vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken);
}

/** Asserts every SDK call so far received the explicit credentials. */
function expectExplicitCredentials(storeId: string) {
  const calls = [
    ...sdk.put.mock.calls.map((call) => call[2]),
    ...sdk.get.mock.calls.map((call) => call[1]),
    ...sdk.del.mock.calls.map((call) => call[1]),
    ...sdk.list.mock.calls.map((call) => call[0]),
  ];
  expect(calls.length).toBeGreaterThan(0);
  for (const options of calls) {
    expect(options).toMatchObject({ storeId, oidcToken });
    expect(options).not.toHaveProperty("token");
  }
}

beforeEach(() => {
  for (const name of [
    "VERCEL_ENV",
    "BLOB_STORE_ID",
    "DEV_BLOB_STORE_ID",
    "VERCEL_OIDC_TOKEN",
    "BLOB_READ_WRITE_TOKEN",
    "DEV_BLOB_READ_WRITE_TOKEN",
  ])
    vi.stubEnv(name, undefined);
  // Fail loudly if anything tries real network access.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network access in unit test");
    }),
  );
  for (const fn of Object.values(sdk)) fn.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("blobConfig", () => {
  it("uses BLOB_STORE_ID in production", () => {
    useEnvironment("production");
    expect(blobConfig()).toEqual({
      storeId: prodStoreId,
      storeIdVariable: "BLOB_STORE_ID",
      oidcToken,
    });
  });

  it.each(["preview", "development", undefined])(
    "uses DEV_BLOB_STORE_ID when VERCEL_ENV is %s",
    (value) => {
      useEnvironment(value);
      expect(blobConfig()).toEqual({
        storeId: devStoreId,
        storeIdVariable: "DEV_BLOB_STORE_ID",
        oidcToken,
      });
    },
  );

  it("requires only the selected store ID", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DEV_BLOB_STORE_ID", devStoreId);
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken);
    const error = (() => {
      try {
        blobConfig();
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as InstanceType<typeof ConfigError>).variables).toEqual([
      "BLOB_STORE_ID",
    ]);
  });

  it("requires the OIDC token and does not fall back to a read-write token", () => {
    vi.stubEnv("DEV_BLOB_STORE_ID", devStoreId);
    vi.stubEnv("DEV_BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_x_y");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_x_y");
    expect(() => blobConfig()).toThrow(ConfigError);
    try {
      blobConfig();
    } catch (error) {
      expect((error as InstanceType<typeof ConfigError>).variables).toEqual([
        "VERCEL_OIDC_TOKEN",
      ]);
    }
  });

  it("never includes a value in its error", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DEV_BLOB_STORE_ID", devStoreId);
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken);
    try {
      blobConfig();
      expect.unreachable();
    } catch (error) {
      expectNoSecrets(error);
      expect(String(error)).not.toContain(devStoreId);
    }
  });
});

describe("operations", () => {
  beforeEach(() => useEnvironment("production"));

  it("putObject writes a private object at the exact pathname", async () => {
    sdk.put.mockResolvedValue({ pathname: "docs/a.pdf" });

    await expect(
      blob.putObject("docs/a.pdf", "body", { contentType: "application/pdf" }),
    ).resolves.toEqual({ pathname: "docs/a.pdf" });

    expect(sdk.put).toHaveBeenCalledWith("docs/a.pdf", "body", {
      storeId: prodStoreId,
      oidcToken,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/pdf",
    });
  });

  it("getObject reads a private object into bytes", async () => {
    sdk.get.mockResolvedValue(found("hello"));

    const result = await blob.getObject(blob.probe.pathname);

    expect(result).toMatchObject({
      pathname: blob.probe.pathname,
      contentType: "text/plain",
    });
    expect(new TextDecoder().decode(result?.body)).toBe("hello");
    expect(sdk.get).toHaveBeenCalledWith(blob.probe.pathname, {
      storeId: prodStoreId,
      oidcToken,
      access: "private",
      useCache: true,
    });
  });

  it("getObject returns null for a missing object", async () => {
    sdk.get.mockResolvedValue(null);
    await expect(blob.getObject("missing.txt")).resolves.toBeNull();
  });

  it("deleteObject deletes with explicit credentials", async () => {
    sdk.del.mockResolvedValue(undefined);
    await blob.deleteObject(["a", "b"]);
    expect(sdk.del).toHaveBeenCalledWith(["a", "b"], {
      storeId: prodStoreId,
      oidcToken,
    });
  });

  it("listObjects lists one page by prefix", async () => {
    const uploadedAt = new Date("2026-11-16T00:00:00Z");
    sdk.list.mockResolvedValue({
      blobs: [
        {
          pathname: "docs/a.pdf",
          size: 3,
          uploadedAt,
          url: "https://x/docs/a.pdf",
          downloadUrl: "https://x/docs/a.pdf?download=1",
          etag: "e",
        },
      ],
      cursor: "next",
      hasMore: true,
    });

    await expect(
      blob.listObjects("docs/", { cursor: "c1", limit: 10 }),
    ).resolves.toEqual({
      objects: [{ pathname: "docs/a.pdf", size: 3, uploadedAt }],
      cursor: "next",
      hasMore: true,
    });
    expect(sdk.list).toHaveBeenCalledWith({
      storeId: prodStoreId,
      oidcToken,
      prefix: "docs/",
      cursor: "c1",
      limit: 10,
    });
  });

  it("maps SDK errors to fixed messages without the SDK text", async () => {
    sdk.put.mockRejectedValue(new BlobAccessError());
    sdk.list.mockRejectedValue(new BlobServiceRateLimited(5));
    sdk.del.mockRejectedValue(leakyError());
    sdk.get.mockRejectedValue(oidcToken);

    const errors = await Promise.all([
      blob.putObject("a", "b").catch((error: unknown) => error),
      blob.listObjects("a").catch((error: unknown) => error),
      blob.deleteObject("a").catch((error: unknown) => error),
      blob.getObject("a").catch((error: unknown) => error),
    ]);

    expect(errors.map((error) => (error as Error).message)).toEqual([
      "blob put failed: access denied",
      "blob list failed: rate limited",
      "blob delete failed: request failed",
      "blob get failed: request failed",
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(blob.BlobOperationError);
      expect((error as Error).cause).toBeUndefined();
      expectNoSecrets(error);
    }
  });

  it("throws a ConfigError and calls nothing when configuration is missing", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
    await expect(blob.putObject("a", "b")).rejects.toBeInstanceOf(ConfigError);
    expect(sdk.put).not.toHaveBeenCalled();
  });
});

describe("checkBlob", () => {
  it.each([
    ["production", "BLOB_STORE_ID", prodStoreId],
    ["preview", "DEV_BLOB_STORE_ID", devStoreId],
    ["development", "DEV_BLOB_STORE_ID", devStoreId],
  ] as const)(
    "passes in %s and reports %s",
    async (vercelEnv, storeIdVariable, storeId) => {
      useEnvironment(vercelEnv);
      healthyStore();

      const result = await blob.checkBlob();

      expect(result).toEqual({
        ok: true,
        latencyMs: expect.any(Number),
        storeIdVariable,
        fingerprint: fingerprint(storeId),
      });
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expectExplicitCredentials(storeId);
      expectNoSecrets(result);
    },
  );

  it("writes, reads back without cache and deletes the probe", async () => {
    useEnvironment("production");
    healthyStore();

    await blob.checkBlob();

    expect(sdk.put).toHaveBeenCalledWith(
      "healthcheck/probe.txt",
      blob.probe.content,
      expect.objectContaining({
        access: "private",
        contentType: "text/plain",
        allowOverwrite: true,
        addRandomSuffix: false,
      }),
    );
    expect(sdk.get).toHaveBeenCalledWith(
      "healthcheck/probe.txt",
      expect.objectContaining({ access: "private", useCache: false }),
    );
    expect(sdk.del).toHaveBeenCalledWith(
      "healthcheck/probe.txt",
      expect.anything(),
    );
  });

  it("fingerprints the store ID including the store_ prefix", async () => {
    useEnvironment("production");
    healthyStore();

    const result = await blob.checkBlob();

    // Pinned: SHA-256("store_ProdSecret123"), first 8 hex characters.
    expect(result.ok && result.fingerprint).toBe("e2492368");
    expect(result.ok && result.fingerprint).not.toBe(
      fingerprint("ProdSecret123"),
    );
    expect(JSON.stringify(result)).not.toContain(prodStoreId);
  });

  it("fails when the read-back differs, and still deletes", async () => {
    useEnvironment("production");
    healthyStore();
    sdk.get.mockImplementation(async () => found("something else"));

    expect(await blob.checkBlob()).toEqual({
      ok: false,
      latencyMs: expect.any(Number),
      storeIdVariable: "BLOB_STORE_ID",
      error: blob.blobCheckErrors.mismatch,
    });
    expect(sdk.del).toHaveBeenCalledTimes(1);
  });

  it("fails when the read-back is missing, and still deletes", async () => {
    useEnvironment("production");
    healthyStore();
    sdk.get.mockResolvedValue(null);

    expect(await blob.checkBlob()).toMatchObject({
      ok: false,
      error: blob.blobCheckErrors.missing,
    });
    expect(sdk.del).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["put", blob.blobCheckErrors.put],
    ["get", blob.blobCheckErrors.get],
  ] as const)(
    "fails when %s throws, and still deletes",
    async (operation, error) => {
      useEnvironment("preview");
      healthyStore();
      sdk[operation].mockRejectedValue(leakyError());

      const result = await blob.checkBlob();

      expect(result).toEqual({
        ok: false,
        latencyMs: expect.any(Number),
        storeIdVariable: "DEV_BLOB_STORE_ID",
        error,
      });
      expect(sdk.del).toHaveBeenCalledTimes(1);
      expectExplicitCredentials(devStoreId);
      expectNoSecrets(result);
    },
  );

  it("fails when the delete throws", async () => {
    useEnvironment("production");
    healthyStore();
    sdk.del.mockRejectedValue(leakyError());

    const result = await blob.checkBlob();

    expect(result).toMatchObject({
      ok: false,
      error: blob.blobCheckErrors.delete,
    });
    expectNoSecrets(result);
  });

  it("reports the earlier error when both read and delete fail", async () => {
    useEnvironment("production");
    healthyStore();
    sdk.get.mockRejectedValue(leakyError());
    sdk.del.mockRejectedValue(leakyError());

    expect(await blob.checkBlob()).toMatchObject({
      ok: false,
      error: blob.blobCheckErrors.get,
    });
  });

  it("reports missing configuration without calling the SDK", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("BLOB_STORE_ID", prodStoreId);

    const result = await blob.checkBlob();

    expect(result).toEqual({
      ok: false,
      latencyMs: expect.any(Number),
      storeIdVariable: "BLOB_STORE_ID",
      error: blob.blobCheckErrors.configuration,
    });
    for (const fn of Object.values(sdk)) expect(fn).not.toHaveBeenCalled();
  });

  it("reports an invalid environment with a null store ID variable", async () => {
    useEnvironment("staging");

    expect(await blob.checkBlob()).toMatchObject({
      ok: false,
      storeIdVariable: null,
      error: blob.blobCheckErrors.configuration,
    });
  });
});
