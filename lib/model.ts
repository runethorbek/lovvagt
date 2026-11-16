/**
 * The one model adapter: the only module that calls Gemini.
 *
 * All other code calls a model through `generateText()` with a task name.
 * The model for each task is set in `models`, so a task can switch model
 * without touching its callers. The API key is read through `lib/config.ts`
 * and passed explicitly, so the SDK's own environment lookup is never used.
 *
 * SDK error messages are never passed on: they can contain request URLs or
 * other details, so they are mapped to fixed messages without a `cause`.
 */
import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import { config } from "@/lib/config";

/**
 * Model ID per task. `gemini-3.5-flash-lite` is a stable Flash-Lite model
 * that is free of charge on the free tier (see the pull request for issue #8
 * for the sources).
 */
export const models = {
  healthcheck: "gemini-3.5-flash-lite",
} as const satisfies Record<string, string>;

export type ModelTask = keyof typeof models;

/** Fixed reasons a model call can fail with. Never contains SDK text. */
export const modelFailureReasons = {
  rateLimited: "rate limited",
  badRequest: "invalid request",
  unauthorised: "authentication failed",
  notFound: "model not found",
  unavailable: "service unavailable",
  unknown: "request failed",
} as const;

export type ModelFailureReason =
  (typeof modelFailureReasons)[keyof typeof modelFailureReasons];

/** Thrown by `generateText()`. Its message is always a fixed string. */
export class ModelError extends Error {
  readonly task: ModelTask;
  readonly reason: ModelFailureReason;
  /** HTTP status from the API, if there was one. */
  readonly status: number | undefined;

  constructor(task: ModelTask, reason: ModelFailureReason, status?: number) {
    super(`model call for ${task} failed: ${reason}`);
    this.name = "ModelError";
    this.task = task;
    this.reason = reason;
    this.status = status;
  }
}

/** Thrown on HTTP 429, so callers can back off. */
export class RateLimitError extends ModelError {
  constructor(task: ModelTask) {
    super(task, modelFailureReasons.rateLimited, 429);
    this.name = "RateLimitError";
  }
}

/** Maps any thrown value to a `ModelError`. The original is discarded. */
function toModelError(task: ModelTask, error: unknown): ModelError {
  if (!(error instanceof ApiError)) {
    return new ModelError(task, modelFailureReasons.unknown);
  }
  const { status } = error;
  if (status === 429) return new RateLimitError(task);
  if (status === 400)
    return new ModelError(task, modelFailureReasons.badRequest, status);
  if (status === 401 || status === 403)
    return new ModelError(task, modelFailureReasons.unauthorised, status);
  if (status === 404)
    return new ModelError(task, modelFailureReasons.notFound, status);
  if (status >= 500)
    return new ModelError(task, modelFailureReasons.unavailable, status);
  return new ModelError(task, modelFailureReasons.unknown, status);
}

export type GenerateOptions = {
  /** Upper limit on output tokens, including thinking tokens. */
  maxOutputTokens?: number;
  /** Thinking level. Supported levels depend on the model. */
  thinkingLevel?: ThinkingLevel;
};

export type GenerateResult = {
  /** The response text; empty if the model returned no text. */
  text: string;
  model: string;
};

/**
 * Sends one prompt to the model configured for `task`. A `ConfigError`
 * (which only names variables) propagates as is; every API or network error
 * becomes a `ModelError`, or a `RateLimitError` on HTTP 429.
 */
export async function generateText(
  task: ModelTask,
  prompt: string,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const { apiKey } = config.gemini();
  const model = models[task];
  try {
    // No `httpOptions.retryOptions`: the SDK then makes exactly one attempt,
    // and back-off is left to callers (catch `RateLimitError`).
    const client = new GoogleGenAI({ apiKey, vertexai: false });
    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: {
        ...(options.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
        ...(options.thinkingLevel !== undefined
          ? { thinkingConfig: { thinkingLevel: options.thinkingLevel } }
          : {}),
      },
    });
    return { text: response.text ?? "", model };
  } catch (error) {
    throw toModelError(task, error);
  }
}

/** The prompt and limits used by `checkGemini()`. Kept minimal for free-tier quotas. */
export const healthcheckRequest = {
  prompt: "Reply with the single word OK.",
  maxOutputTokens: 16,
  thinkingLevel: ThinkingLevel.MINIMAL,
} as const;

/** Fixed error messages returned by `checkGemini()`. */
export const geminiCheckErrors = {
  configuration: "configuration missing or invalid",
  emptyResponse: "empty response",
  ...modelFailureReasons,
} as const;

export type GeminiCheckError =
  (typeof geminiCheckErrors)[keyof typeof geminiCheckErrors];

export type GeminiCheck =
  | { ok: true; latencyMs: number; model: string }
  | { ok: false; latencyMs: number; model: string; error: GeminiCheckError };

/**
 * Sends a minimal prompt to the `healthcheck` model and checks that the
 * response text is not empty. Never throws, and never returns the key.
 */
export async function checkGemini(): Promise<GeminiCheck> {
  const start = performance.now();
  const model = models.healthcheck;
  const latencyMs = () => Math.round(performance.now() - start);
  const fail = (error: GeminiCheckError): GeminiCheck => ({
    ok: false,
    latencyMs: latencyMs(),
    model,
    error,
  });

  try {
    config.gemini();
  } catch {
    return fail(geminiCheckErrors.configuration);
  }

  let text: string;
  try {
    ({ text } = await generateText("healthcheck", healthcheckRequest.prompt, {
      maxOutputTokens: healthcheckRequest.maxOutputTokens,
      thinkingLevel: healthcheckRequest.thinkingLevel,
    }));
  } catch (error) {
    return fail(
      error instanceof ModelError ? error.reason : geminiCheckErrors.unknown,
    );
  }

  if (text.trim() === "") return fail(geminiCheckErrors.emptyResponse);
  return { ok: true, latencyMs: latencyMs(), model };
}
