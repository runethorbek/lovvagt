import { createHash } from "node:crypto";

/**
 * A short, non-reversible identifier for a value such as a host name, so
 * environments can be compared without exposing the value itself.
 * Returns the first 8 lowercase hex characters of the SHA-256 hash.
 */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}
