/**
 * Blob credentials. Together with the blob helper in `lib/blob/`, this is the
 * only place that names the blob variables (see CLAUDE.md and ADR 0004).
 *
 * Blob is authenticated with Vercel OIDC: a short-lived token plus the ID of
 * the store. Production uses `BLOB_STORE_ID`; preview and development use
 * `DEV_BLOB_STORE_ID`. Only the selected store ID variable is required.
 * There is deliberately no fallback to read-write tokens.
 *
 * In a Vercel Function the token arrives per request in the
 * `x-vercel-oidc-token` header, exposed through Vercel's request context;
 * locally and during builds it is the `VERCEL_OIDC_TOKEN` variable (from
 * `vercel env pull`). The header wins. See ADR 0005.
 */
import { getContext } from "@vercel/oidc";
import { z } from "zod";
import { environment, readEnv } from "@/lib/config";

export const blobStoreIdVariables = {
  production: "BLOB_STORE_ID",
  other: "DEV_BLOB_STORE_ID",
} as const;

export type BlobStoreIdVariable =
  (typeof blobStoreIdVariables)[keyof typeof blobStoreIdVariables];

export const oidcTokenVariable = "VERCEL_OIDC_TOKEN";

/** The request header that carries the OIDC token inside Vercel Functions. */
export const oidcTokenHeader = "x-vercel-oidc-token";

/** The token from the current request context, or `undefined` outside one. */
function oidcTokenFromRequest(): string | undefined {
  const token = getContext().headers?.[oidcTokenHeader]?.trim();
  return token ? token : undefined;
}

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

/**
 * Throws a `ConfigError` naming the missing variables, never their values.
 * The token variable is required only when the request context has no token.
 */
export function blobConfig(): BlobConfig {
  const storeIdVariable = blobStoreIdVariable();
  const required = z.string().trim().min(1);
  const requestToken = oidcTokenFromRequest();
  const env: Record<string, unknown> = readEnv({
    [storeIdVariable]: required,
    ...(requestToken === undefined ? { [oidcTokenVariable]: required } : {}),
  });
  return {
    storeId: env[storeIdVariable] as string,
    storeIdVariable,
    oidcToken: requestToken ?? (env[oidcTokenVariable] as string),
  };
}
