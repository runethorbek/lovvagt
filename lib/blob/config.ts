/**
 * Blob credentials. Together with the blob helper in `lib/blob/`, this is the
 * only place that names the blob variables (see CLAUDE.md and ADR 0004).
 *
 * Blob is authenticated with Vercel OIDC: a short-lived `VERCEL_OIDC_TOKEN`
 * plus the ID of the store. Production uses `BLOB_STORE_ID`; preview and
 * development use `DEV_BLOB_STORE_ID`. Only the selected store ID variable
 * is required. There is deliberately no fallback to read-write tokens.
 */
import { z } from "zod";
import { environment, readEnv } from "@/lib/config";

export const blobStoreIdVariables = {
  production: "BLOB_STORE_ID",
  other: "DEV_BLOB_STORE_ID",
} as const;

export type BlobStoreIdVariable =
  (typeof blobStoreIdVariables)[keyof typeof blobStoreIdVariables];

export const oidcTokenVariable = "VERCEL_OIDC_TOKEN";

export type BlobConfig = {
  /** The store ID as stored in the variable, including the `store_` prefix. */
  storeId: string;
  storeIdVariable: BlobStoreIdVariable;
  /** Secret. Never log or return it. */
  oidcToken: string;
};

/** The store ID variable for the current environment. */
export function blobStoreIdVariable(): BlobStoreIdVariable {
  return environment() === "production"
    ? blobStoreIdVariables.production
    : blobStoreIdVariables.other;
}

/** Throws a `ConfigError` naming the missing variables, never their values. */
export function blobConfig(): BlobConfig {
  const storeIdVariable = blobStoreIdVariable();
  const required = z.string().trim().min(1);
  const env = readEnv({
    [storeIdVariable]: required,
    [oidcTokenVariable]: required,
  });
  return {
    storeId: env[storeIdVariable] as string,
    storeIdVariable,
    oidcToken: env[oidcTokenVariable] as string,
  };
}
