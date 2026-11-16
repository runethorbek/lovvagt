import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The SDK client is mocked: no test in this file may reach Gemini. The real
// `ApiError` and `ThinkingLevel` are kept, so error mapping is tested against
// the SDK's own error class.
const generateContent = vi.fn();
const clientOptions = vi.fn();
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class GoogleGenAI {
    readonly models = { generateContent };
    constructor(options: unknown) {
      clientOptions(options);
    }
  }
  return { ...actual, GoogleGenAI };
});

const { ApiError, ThinkingLevel } = await import("@google/genai");
const {
  checkGemini,
  generateText,
  geminiCheckErrors,
  healthcheckRequest,
  ModelError,
  modelFailureReasons,
  models,
  RateLimitError,
} = await import("@/lib/model");
const { ConfigError } = await import("@/lib/config");

const apiKey = "AIzaSy-secret-gemini-key-0123456789";

function expectNoKey(value: unknown) {
  const texts = [JSON.stringify(value), String(value)];
  if (value instanceof Error) texts.push(value.message, value.stack ?? "");
  for (const text of texts) expect(text).not.toContain(apiKey);
}

/** An SDK error whose message contains the key, as a request URL might. */
function leakyApiError(status: number) {
  return new ApiError({
    status,
    message: `request to https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey} failed`,
  });
}

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", apiKey);
  // Fail loudly if anything tries real network access.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network access in unit test");
    }),
  );
  generateContent.mockReset();
  clientOptions.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("models", () => {
  it("configures a model for the healthcheck task", () => {
    expect(models.healthcheck).toBe("gemini-3.5-flash-lite");
  });
});

describe("generateText", () => {
  it("passes the key explicitly and uses the task's model", async () => {
    generateContent.mockResolvedValue({ text: "hello" });

    const result = await generateText("healthcheck", "hi", {
      maxOutputTokens: 5,
      thinkingLevel: ThinkingLevel.MINIMAL,
    });

    expect(result).toEqual({ text: "hello", model: models.healthcheck });
    expect(clientOptions).toHaveBeenCalledWith({ apiKey, vertexai: false });
    expect(generateContent).toHaveBeenCalledWith({
      model: models.healthcheck,
      contents: "hi",
      config: {
        maxOutputTokens: 5,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });
  });

  it("takes the model ID from the per-task configuration", async () => {
    generateContent.mockResolvedValue({ text: "x" });
    const original = models.healthcheck;
    // Swap the task's model to show it is looked up on each call.
    (models as Record<string, string>).healthcheck = "test-model-id";
    try {
      const result = await generateText("healthcheck", "hi");
      expect(result.model).toBe("test-model-id");
      expect(generateContent).toHaveBeenCalledWith(
        expect.objectContaining({ model: "test-model-id" }),
      );
    } finally {
      (models as Record<string, string>).healthcheck = original;
    }
  });

  it("returns empty text when the response has none", async () => {
    generateContent.mockResolvedValue({ text: undefined });

    expect(await generateText("healthcheck", "hi")).toEqual({
      text: "",
      model: models.healthcheck,
    });
  });

  it("throws RateLimitError on HTTP 429", async () => {
    generateContent.mockRejectedValue(leakyApiError(429));

    const error = await generateText("healthcheck", "hi").catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      name: "RateLimitError",
      task: "healthcheck",
      reason: modelFailureReasons.rateLimited,
      status: 429,
      message: "model call for healthcheck failed: rate limited",
    });
    expect((error as Error).cause).toBeUndefined();
    expectNoKey(error);
  });

  it.each([
    [400, modelFailureReasons.badRequest],
    [401, modelFailureReasons.unauthorised],
    [403, modelFailureReasons.unauthorised],
    [404, modelFailureReasons.notFound],
    [500, modelFailureReasons.unavailable],
    [503, modelFailureReasons.unavailable],
    [418, modelFailureReasons.unknown],
  ])("maps HTTP %i to a generic ModelError (%s)", async (status, reason) => {
    generateContent.mockRejectedValue(leakyApiError(status));

    const error = await generateText("healthcheck", "hi").catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ModelError);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ reason, status });
    expect((error as Error).cause).toBeUndefined();
    expectNoKey(error);
  });

  it("maps a non-API error to a generic ModelError without its message", async () => {
    generateContent.mockRejectedValue(new TypeError(`fetch failed ${apiKey}`));

    const error = await generateText("healthcheck", "hi").catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      reason: modelFailureReasons.unknown,
      status: undefined,
    });
    expectNoKey(error);
  });

  it("propagates ConfigError when the key is missing", async () => {
    vi.stubEnv("GEMINI_API_KEY", undefined);

    await expect(generateText("healthcheck", "hi")).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("checkGemini", () => {
  it("succeeds on a non-empty response with a minimal request", async () => {
    generateContent.mockResolvedValue({ text: "OK" });

    const result = await checkGemini();

    expect(result).toEqual({
      ok: true,
      latencyMs: expect.any(Number),
      model: models.healthcheck,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent).toHaveBeenCalledWith({
      model: models.healthcheck,
      contents: healthcheckRequest.prompt,
      config: {
        maxOutputTokens: healthcheckRequest.maxOutputTokens,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });
    expect(healthcheckRequest.maxOutputTokens).toBeLessThanOrEqual(16);
    expectNoKey(result);
  });

  it.each([undefined, "", "  \n"])(
    "fails on an empty response (%j)",
    async (text) => {
      generateContent.mockResolvedValue({ text });

      expect(await checkGemini()).toEqual({
        ok: false,
        latencyMs: expect.any(Number),
        model: models.healthcheck,
        error: geminiCheckErrors.emptyResponse,
      });
    },
  );

  it("reports a rate limit on HTTP 429", async () => {
    generateContent.mockRejectedValue(leakyApiError(429));

    const result = await checkGemini();

    expect(result).toMatchObject({
      ok: false,
      error: geminiCheckErrors.rateLimited,
    });
    expectNoKey(result);
  });

  it("reports another API error without leaking its message", async () => {
    generateContent.mockRejectedValue(leakyApiError(403));

    const result = await checkGemini();

    expect(result).toMatchObject({
      ok: false,
      error: geminiCheckErrors.unauthorised,
    });
    expectNoKey(result);
  });

  it("reports a non-Error rejection containing the key as a request failure", async () => {
    generateContent.mockRejectedValue(apiKey);

    const result = await checkGemini();

    expect(result).toMatchObject({
      ok: false,
      error: geminiCheckErrors.unknown,
    });
    expectNoKey(result);
  });

  it("reports missing configuration without calling the SDK", async () => {
    vi.stubEnv("GEMINI_API_KEY", undefined);

    expect(await checkGemini()).toMatchObject({
      ok: false,
      model: models.healthcheck,
      error: geminiCheckErrors.configuration,
    });
    expect(generateContent).not.toHaveBeenCalled();
  });
});
