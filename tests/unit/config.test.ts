import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobConfig } from "@/lib/blob/config";
import { ConfigError, config, environment } from "@/lib/config";

const variables = [
  "VERCEL_ENV",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "GEMINI_API_KEY",
  "CRON_SECRET",
];

// Distinctive values, so a test can assert none of them leaks into errors.
const secrets = {
  DATABASE_URL: "postgresql://user:pw-secret-1@db-host-secret/db",
  DATABASE_URL_UNPOOLED: "postgresql://user:pw-secret-2@db-host-secret/db",
  GEMINI_API_KEY: "gemini-secret-5",
  CRON_SECRET: "cron-secret-6",
};

function setAll() {
  for (const [name, value] of Object.entries(secrets)) vi.stubEnv(name, value);
}

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

beforeEach(() => {
  for (const name of variables) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("environment", () => {
  it.each(["production", "preview", "development"] as const)(
    "resolves %s",
    (value) => {
      vi.stubEnv("VERCEL_ENV", value);
      expect(environment()).toBe(value);
      expect(config.environment()).toBe(value);
    },
  );

  it("treats a missing VERCEL_ENV as development", () => {
    expect(environment()).toBe("development");
  });

  it("treats an empty VERCEL_ENV as development", () => {
    vi.stubEnv("VERCEL_ENV", "");
    expect(environment()).toBe("development");
  });

  it("rejects an unknown value, naming the variable but not the value", () => {
    vi.stubEnv("VERCEL_ENV", "staging-xyz");
    const error = errorOf(() => environment());
    expect(error.variables).toEqual(["VERCEL_ENV"]);
    expect(error.message).toContain("VERCEL_ENV");
    expect(error.message).not.toContain("staging-xyz");
  });
});

describe("import", () => {
  it("does not throw when no variables are set", async () => {
    vi.resetModules();
    await expect(import("@/lib/config")).resolves.toBeDefined();
    await expect(import("@/lib/blob/config")).resolves.toBeDefined();
  });
});

describe("grouped accessors", () => {
  it("return validated values when all variables are set", () => {
    setAll();
    expect(config.database()).toEqual({
      url: secrets.DATABASE_URL,
      unpooledUrl: secrets.DATABASE_URL_UNPOOLED,
    });
    expect(config.gemini()).toEqual({ apiKey: secrets.GEMINI_API_KEY });
    expect(config.cronSecret()).toBe(secrets.CRON_SECRET);
  });

  it("name each missing variable", () => {
    expect(errorOf(() => config.database()).variables).toEqual([
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
    ]);
    expect(errorOf(() => config.gemini()).message).toContain("GEMINI_API_KEY");
    expect(errorOf(() => config.cronSecret()).message).toContain("CRON_SECRET");
  });

  it("treat an empty string as missing", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(errorOf(() => config.cronSecret()).variables).toEqual([
      "CRON_SECRET",
    ]);
  });

  it("reject a database URL that is not a Postgres URL", () => {
    setAll();
    vi.stubEnv("DATABASE_URL", "mysql://host-secret-7/db");
    const error = errorOf(() => config.database());
    expect(error.variables).toEqual(["DATABASE_URL"]);
    expect(error.message).not.toContain("host-secret-7");
  });

  it("validate only their own variables", () => {
    vi.stubEnv("GEMINI_API_KEY", secrets.GEMINI_API_KEY);
    expect(config.gemini().apiKey).toBe(secrets.GEMINI_API_KEY);
    const error = errorOf(() => config.cronSecret());
    expect(error.variables).toEqual(["CRON_SECRET"]);
  });

  it("never include a variable value in an error message", () => {
    setAll();
    vi.stubEnv("DATABASE_URL", "not-a-url-secret-8");
    vi.stubEnv("VERCEL_ENV", "bogus-secret-9");
    const messages = [
      errorOf(() => config.database()),
      errorOf(() => environment()),
      errorOf(() => blobConfig()),
    ].map((error) => `${error.message} ${String(error.stack)}`);

    const values = [
      ...Object.values(secrets),
      "not-a-url-secret-8",
      "bogus-secret-9",
    ];
    for (const message of messages) {
      for (const value of values) expect(message).not.toContain(value);
    }
  });
});

// blobConfig() is tested in blob.test.ts, the one test file allowed to name
// the blob variables (see boundaries.test.ts).
