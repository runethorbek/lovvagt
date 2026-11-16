/**
 * Blob token selection. Together with the blob helper in `lib/blob/`, this is
 * the only place that names the blob token variables (see CLAUDE.md).
 * Production uses `BLOB_READ_WRITE_TOKEN`; preview and development use
 * `DEV_BLOB_READ_WRITE_TOKEN`. Only the selected variable is required.
 */
import { z } from "zod";
import { environment, readEnv } from "@/lib/config";

export const blobTokenVariables = {
  production: "BLOB_READ_WRITE_TOKEN",
  other: "DEV_BLOB_READ_WRITE_TOKEN",
} as const;

export type BlobTokenVariable =
  (typeof blobTokenVariables)[keyof typeof blobTokenVariables];

export function blobConfig(): {
  token: string;
  tokenVariable: BlobTokenVariable;
} {
  const tokenVariable =
    environment() === "production"
      ? blobTokenVariables.production
      : blobTokenVariables.other;
  const env = readEnv({ [tokenVariable]: z.string().trim().min(1) });
  return { token: env[tokenVariable] as string, tokenVariable };
}
