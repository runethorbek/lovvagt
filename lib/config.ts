/**
 * The one module that reads environment variables.
 *
 * All other code gets configuration from here, never from `process.env`.
 * Importing this module never throws: each accessor validates only its own
 * variables, on every call, so one missing variable cannot break unrelated
 * code. Errors name the variable, never its value. See ADR 0003.
 */
import { z } from "zod";

export const environments = ["production", "preview", "development"] as const;
export type Environment = (typeof environments)[number];

/** Thrown when variables are missing or invalid. Never contains values. */
export class ConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(
      `Invalid configuration: missing or invalid environment variable(s): ${variables.join(", ")}`,
    );
    this.name = "ConfigError";
    this.variables = variables;
  }
}

/**
 * Validates the variables named by the keys of `shape` and returns them typed.
 * Empty strings count as missing, so `.env.example`-style `NAME=` lines fail.
 *
 * Exported so that a module that must own its variable names (the blob
 * helper) can define its schema without reading `process.env` itself.
 */
export function readEnv<Shape extends z.ZodRawShape>(
  shape: Shape,
): z.infer<z.ZodObject<Shape>> {
  const input: Record<string, string | undefined> = {};
  for (const name of Object.keys(shape)) {
    const value = process.env[name];
    input[name] = value === "" ? undefined : value;
  }

  const result = z.object(shape).safeParse(input);
  if (!result.success) {
    // Build the message from variable names only. Zod issue messages are
    // deliberately not used, so no value can leak through them.
    const variables = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
    ];
    throw new ConfigError(variables);
  }
  return result.data;
}

const required = z.string().trim().min(1);
const postgresUrl = required.regex(/^postgres(ql)?:\/\//);

/** Resolves the deployment environment from `VERCEL_ENV`. Missing means development. */
export function environment(): Environment {
  return readEnv({
    VERCEL_ENV: z.enum(environments).default("development"),
  }).VERCEL_ENV;
}

export const config = {
  environment,

  database() {
    const env = readEnv({
      DATABASE_URL: postgresUrl,
      DATABASE_URL_UNPOOLED: postgresUrl,
    });
    return { url: env.DATABASE_URL, unpooledUrl: env.DATABASE_URL_UNPOOLED };
  },

  gemini() {
    return { apiKey: readEnv({ GEMINI_API_KEY: required }).GEMINI_API_KEY };
  },

  cronSecret() {
    return readEnv({ CRON_SECRET: required }).CRON_SECRET;
  },
};
