/**
 * Tests for `GET /api/health` (`app/api/health/route.ts` and `lib/health.ts`).
 * The three checks are mocked: no test in this file may reach Neon, Blob or
 * Gemini.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checks = vi.hoisted(() => ({
  checkDatabase: vi.fn(),
  checkBlob: vi.fn(),
  checkGemini: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ checkDatabase: checks.checkDatabase }));
vi.mock("@/lib/blob", () => ({ checkBlob: checks.checkBlob }));
vi.mock("@/lib/model", () => ({
  checkGemini: checks.checkGemini,
  models: { healthcheck: "test-model" },
}));

const { GET, dynamic } = await import("@/app/api/health/route");
const { checkTimeoutMs, healthErrors, isAuthorised } =
  await import("@/lib/health");
const { blobStoreIdVariable, blobStoreIdVariables } =
  await import("@/lib/blob/config");

const secret = "cron-secret-5a7c1e";
const url = "http://localhost/api/health";

function request(authorization?: string): Request {
  return new Request(
    url,
    authorization === undefined ? {} : { headers: { authorization } },
  );
}

const passing = {
  database: { ok: true, latencyMs: 12, fingerprint: "a1b2c3d4" },
  blob: {
    ok: true,
    latencyMs: 34,
    storeIdVariable: blobStoreIdVariables.other,
    fingerprint: "e5f6a7b8",
  },
  gemini: { ok: true, latencyMs: 56, model: "test-model" },
};

function allPass() {
  checks.checkDatabase.mockResolvedValue(passing.database);
  checks.checkBlob.mockResolvedValue(passing.blob);
  checks.checkGemini.mockResolvedValue(passing.gemini);
}

function expectNoChecksRun() {
  expect(checks.checkDatabase).not.toHaveBeenCalled();
  expect(checks.checkBlob).not.toHaveBeenCalled();
  expect(checks.checkGemini).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "development");
  vi.stubEnv("CRON_SECRET", secret);
  // Fail loudly if anything tries real network access.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network access in unit test");
    }),
  );
  for (const check of Object.values(checks)) check.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("route configuration", () => {
  it("is always dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("unauthorised requests", () => {
  async function expectUnauthorised(response: Response) {
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expectNoChecksRun();
  }

  it("returns 401 without an Authorization header", async () => {
    allPass();
    await expectUnauthorised(await GET(request()));
  });

  it("returns 401 with a wrong secret", async () => {
    allPass();
    await expectUnauthorised(await GET(request("Bearer wrong-secret")));
  });

  it("returns 401 with the secret plus extra characters", async () => {
    allPass();
    await expectUnauthorised(await GET(request(`Bearer ${secret}x`)));
  });

  it("returns 401 with the right secret under another scheme", async () => {
    allPass();
    await expectUnauthorised(await GET(request(`Basic ${secret}`)));
    await expectUnauthorised(await GET(request(secret)));
  });

  it("returns 401 when CRON_SECRET is unset, even for an empty bearer", async () => {
    allPass();
    vi.stubEnv("CRON_SECRET", undefined);
    await expectUnauthorised(await GET(request("Bearer ")));
    await expectUnauthorised(await GET(request("Bearer undefined")));
    await expectUnauthorised(await GET(request()));
  });

  it("returns 401 when CRON_SECRET is empty", async () => {
    allPass();
    vi.stubEnv("CRON_SECRET", "");
    await expectUnauthorised(await GET(request("Bearer ")));
  });
});

describe("isAuthorised", () => {
  it("accepts the bearer scheme case-insensitively", () => {
    expect(isAuthorised(`Bearer ${secret}`)).toBe(true);
    expect(isAuthorised(`bearer ${secret}`)).toBe(true);
  });

  it("rejects a secret that differs only in case", () => {
    expect(isAuthorised(`Bearer ${secret.toUpperCase()}`)).toBe(false);
  });
});

describe("authorised requests", () => {
  it("returns 200 with the spec's JSON shape when all checks pass", async () => {
    allPass();
    const response = await GET(request(`Bearer ${secret}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      environment: "development",
      ok: true,
      checks: passing,
    });
    expect(checks.checkDatabase).toHaveBeenCalledOnce();
    expect(checks.checkBlob).toHaveBeenCalledOnce();
    expect(checks.checkGemini).toHaveBeenCalledOnce();
  });

  it("reports the production environment", async () => {
    allPass();
    vi.stubEnv("VERCEL_ENV", "production");
    const body = await (await GET(request(`Bearer ${secret}`))).json();
    expect(body.environment).toBe("production");
  });

  it("returns 503 when one check fails", async () => {
    allPass();
    const failed = { ok: false, latencyMs: 7, error: "connection failed" };
    checks.checkDatabase.mockResolvedValue(failed);

    const response = await GET(request(`Bearer ${secret}`));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      environment: "development",
      ok: false,
      checks: { ...passing, database: failed },
    });
  });

  it("runs the checks in parallel", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    for (const [name, check] of Object.entries(checks)) {
      check.mockImplementation(async () => {
        started.push(name);
        await gate;
        return passing[
          name.replace("check", "").toLowerCase() as keyof typeof passing
        ];
      });
    }

    const pending = GET(request(`Bearer ${secret}`));
    await vi.waitFor(() => expect(started).toHaveLength(3));
    release();
    expect((await pending).status).toBe(200);
  });

  it("returns 503 with error timeout when one check times out", async () => {
    vi.useFakeTimers();
    allPass();
    checks.checkGemini.mockReturnValue(new Promise(() => {}));

    const pending = GET(request(`Bearer ${secret}`));
    await vi.advanceTimersByTimeAsync(checkTimeoutMs);
    const response = await pending;

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.database).toEqual(passing.database);
    expect(body.checks.blob).toEqual(passing.blob);
    expect(body.checks.gemini).toMatchObject({
      ok: false,
      model: "test-model",
      error: "timeout",
    });
    expect(typeof body.checks.gemini.latencyMs).toBe("number");
  });

  it("names the store ID variable when the blob check times out", async () => {
    vi.useFakeTimers();
    allPass();
    checks.checkBlob.mockReturnValue(new Promise(() => {}));

    const pending = GET(request(`Bearer ${secret}`));
    await vi.advanceTimersByTimeAsync(checkTimeoutMs);
    const body = await (await pending).json();

    expect(body.checks.blob).toMatchObject({
      ok: false,
      storeIdVariable: blobStoreIdVariable(),
      error: healthErrors.timeout,
    });
  });

  it("does not time out a check that answers just in time", async () => {
    vi.useFakeTimers();
    allPass();
    checks.checkDatabase.mockReturnValue(
      new Promise((resolve) =>
        setTimeout(() => resolve(passing.database), checkTimeoutMs - 1),
      ),
    );

    const pending = GET(request(`Bearer ${secret}`));
    await vi.advanceTimersByTimeAsync(checkTimeoutMs);
    expect((await pending).status).toBe(200);
  });

  it("reports a rejecting check as failed with a fixed error", async () => {
    allPass();
    checks.checkBlob.mockRejectedValue(new Error(`leak ${secret}`));

    const response = await GET(request(`Bearer ${secret}`));
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).checks.blob.error).toBe(healthErrors.unexpected);
  });

  it("returns 503 with environment null for an unknown VERCEL_ENV", async () => {
    allPass();
    vi.stubEnv("VERCEL_ENV", "staging");
    const response = await GET(request(`Bearer ${secret}`));
    expect(response.status).toBe(503);
    expect((await response.json()).environment).toBeNull();
  });
});

describe("no environment value in any response", () => {
  // Every variable in `.env.example`, read at runtime so this file does not
  // name the blob variables (see boundaries.test.ts).
  const names = readFileSync(
    join(import.meta.dirname, "..", "..", ".env.example"),
    "utf8",
  )
    .split("\n")
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

  // Distinctive fake values; a URL-shaped one for the connection strings.
  const fakes = Object.fromEntries(
    names.map((name) => [
      name,
      name.startsWith("DATABASE_URL")
        ? `postgresql://fakeuser:fakepw-${name}@fake-host-${name}.example/fakedb`
        : `fake-value-${name}-3f9d`,
    ]),
  );

  beforeEach(() => {
    for (const [name, value] of Object.entries(fakes)) vi.stubEnv(name, value);
  });

  it("covers every variable in .env.example, including CRON_SECRET", () => {
    expect(names).toContain("CRON_SECRET");
    expect(names).toContain("DATABASE_URL");
    expect(names).toContain("GEMINI_API_KEY");
    expect(names.length).toBeGreaterThanOrEqual(7);
  });

  async function expectNoValues(response: Response) {
    const text = `${await response.text()} ${JSON.stringify([...response.headers])}`;
    for (const [name, value] of Object.entries(fakes)) {
      expect(text, `value of ${name}`).not.toContain(value);
    }
  }

  const auth = () => `Bearer ${fakes.CRON_SECRET}`;

  it("leaks nothing on 200", async () => {
    allPass();
    const response = await GET(request(auth()));
    expect(response.status).toBe(200);
    await expectNoValues(response);
  });

  it("leaks nothing on 503, including timeouts", async () => {
    vi.useFakeTimers();
    checks.checkDatabase.mockResolvedValue({
      ok: false,
      latencyMs: 1,
      error: "connection failed",
    });
    checks.checkBlob.mockReturnValue(new Promise(() => {}));
    checks.checkGemini.mockRejectedValue(
      new Error(`key ${fakes.GEMINI_API_KEY}`),
    );

    const pending = GET(request(auth()));
    await vi.advanceTimersByTimeAsync(checkTimeoutMs);
    const response = await pending;
    expect(response.status).toBe(503);
    await expectNoValues(response);
  });

  it("leaks nothing on 401", async () => {
    allPass();
    const response = await GET(request("Bearer wrong"));
    expect(response.status).toBe(401);
    await expectNoValues(response);
  });
});
