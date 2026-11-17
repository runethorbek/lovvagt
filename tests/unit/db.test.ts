import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The driver is mocked: no test in this file may reach Neon.
const query = vi.fn();
const neon = vi.fn((connectionString: string) => {
  void connectionString;
  return query;
});
vi.mock("@neondatabase/serverless", () => ({ neon }));

const { checkDatabase, databaseErrors, db, fingerprintInput } =
  await import("@/lib/db");
const { fingerprint } = await import("@/lib/fingerprint");

const user = "secret_user";
const password = "pw-secret-9f8e7d";
const host = "ep-secret-host-123-pooler.eu-central-1.aws.neon.tech";
const database = "secret_db";
const url = `postgresql://${user}:${password}@${host}/${database}?sslmode=require`;
const unpooledUrl = url.replace("-pooler", "");

/** Every value that must never appear in a result. */
const sensitive = [url, unpooledUrl, user, password, host, database];

function expectNoSecrets(result: unknown) {
  const text = JSON.stringify(result);
  for (const value of sensitive) expect(text).not.toContain(value);
}

/** An error shaped like the driver's, with the connection details inside. */
function leakyError(code?: string) {
  const error = new Error(
    `connect to ${url} failed for user ${user} password ${password} host ${host} db ${database}`,
  ) as Error & { code?: string };
  if (code) error.code = code;
  return error;
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", url);
  vi.stubEnv("DATABASE_URL_UNPOOLED", unpooledUrl);
  // Fail loudly if anything tries real network access.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network access in unit test");
    }),
  );
  query.mockReset();
  neon.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("db", () => {
  it("creates the client with the pooled DATABASE_URL", () => {
    expect(db()).toBe(query);
    expect(neon).toHaveBeenCalledWith(url);
  });
});

describe("fingerprintInput", () => {
  it("is the lowercase host without port, a slash and the database", () => {
    expect(
      fingerprintInput("postgres://u:p@Host.Example:5432/my%20db?x=1"),
    ).toBe("host.example/my db");
  });

  it("rejects a URL without a database", () => {
    expect(() => fingerprintInput("postgres://u:p@host/")).toThrow();
  });
});

describe("checkDatabase", () => {
  it("succeeds with a numeric latency and the expected fingerprint", async () => {
    query.mockResolvedValue([{ ok: 1 }]);

    const result = await checkDatabase();

    expect(result).toEqual({
      ok: true,
      latencyMs: expect.any(Number),
      fingerprint: fingerprint(`${host}/${database}`),
    });
    // Pinned value for this known URL, so a change to the input format is noticed.
    // SHA-256("ep-secret-host-123-pooler.eu-central-1.aws.neon.tech/secret_db")
    expect(result.ok && result.fingerprint).toBe("0c7ef49d");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(neon).toHaveBeenCalledWith(url);
    expect(query).toHaveBeenCalledTimes(1);
    const [strings] = query.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join("")).toBe("SELECT 1 AS ok");
    expectNoSecrets(result);
  });

  it("reports a connection failure without leaking the driver message", async () => {
    query.mockRejectedValue(leakyError());

    const result = await checkDatabase();

    expect(result).toEqual({
      ok: false,
      latencyMs: expect.any(Number),
      error: databaseErrors.connection,
    });
    expectNoSecrets(result);
  });

  it("reports a query failure for a Postgres error code", async () => {
    query.mockRejectedValue(leakyError("42601"));

    const result = await checkDatabase();

    expect(result).toMatchObject({ ok: false, error: databaseErrors.query });
    expectNoSecrets(result);
  });

  /**
   * Shaped like the driver's errors over HTTP (`@neondatabase/serverless`
   * 1.2.1): an HTTP 400 copies the server's JSON fields onto a `NeonDbError`,
   * and a wrong password arrives with an empty `code`.
   */
  function neonHttpError(message: string, code: string | undefined) {
    const error = new Error(message) as Error & { code?: string };
    error.name = "NeonDbError";
    error.code = code;
    return error;
  }

  it.each([
    ["an empty code", ""],
    ["no code", undefined],
  ])(
    "reports an authentication failure for a Neon HTTP error with %s",
    async (_label, code) => {
      query.mockRejectedValue(
        neonHttpError(
          `password authentication failed for user '${user}' (${url})`,
          code,
        ),
      );

      const result = await checkDatabase();

      expect(result).toEqual({
        ok: false,
        latencyMs: expect.any(Number),
        error: databaseErrors.authentication,
      });
      expectNoSecrets(result);
    },
  );

  it.each(["28P01", "28000"])(
    "reports an authentication failure for SQLSTATE %s",
    async (code) => {
      query.mockRejectedValue(leakyError(code));

      const result = await checkDatabase();

      expect(result).toMatchObject({
        ok: false,
        error: databaseErrors.authentication,
      });
      expectNoSecrets(result);
    },
  );

  it("still reports a network error from the driver as a connection failure", async () => {
    query.mockRejectedValue(
      neonHttpError(
        `Error connecting to database: TypeError: fetch failed (${url})`,
        undefined,
      ),
    );

    expect(await checkDatabase()).toMatchObject({
      ok: false,
      error: databaseErrors.connection,
    });
  });

  it("does not treat an authentication phrase in a non-Error as authentication", async () => {
    query.mockRejectedValue("password authentication failed");

    expect(await checkDatabase()).toMatchObject({
      ok: false,
      error: databaseErrors.connection,
    });
  });

  it("reports a non-Error rejection containing secrets as a connection failure", async () => {
    query.mockRejectedValue(url);

    const result = await checkDatabase();

    expect(result).toMatchObject({
      ok: false,
      error: databaseErrors.connection,
    });
    expectNoSecrets(result);
  });

  it("reports an unexpected result", async () => {
    query.mockResolvedValue([]);

    expect(await checkDatabase()).toMatchObject({
      ok: false,
      error: databaseErrors.unexpectedResult,
    });
  });

  it("reports an invalid connection string when the driver rejects it", async () => {
    neon.mockImplementationOnce(() => {
      throw leakyError();
    });

    const result = await checkDatabase();

    expect(result).toMatchObject({
      ok: false,
      error: databaseErrors.connectionString,
    });
    expectNoSecrets(result);
  });

  it("reports an invalid connection string without a database", async () => {
    vi.stubEnv("DATABASE_URL", `postgresql://${user}:${password}@${host}/`);

    const result = await checkDatabase();

    expect(result).toMatchObject({
      ok: false,
      error: databaseErrors.connectionString,
    });
    expect(query).not.toHaveBeenCalled();
    expectNoSecrets(result);
  });

  it("reports missing configuration", async () => {
    vi.stubEnv("DATABASE_URL", undefined);

    const result = await checkDatabase();

    expect(result).toMatchObject({
      ok: false,
      error: databaseErrors.configuration,
    });
    expect(neon).not.toHaveBeenCalled();
  });
});
