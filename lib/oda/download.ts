/**
 * Downloads a file referenced by `Fil.filurl` (served from ft.dk), with a
 * size limit. Uses the same sequential, retrying request layer as the
 * queries. The URL extension says nothing about the format: callers check
 * the bytes against `Fil.format`.
 */
import {
  odaFailureReasons,
  OdaError,
  OdaFileTooLargeError,
  odaRequest,
  type OdaRequestOptions,
} from "@/lib/oda/client";

/** Default maximum file size: 25 MB. */
export const defaultMaxFileBytes = 25 * 1024 * 1024;

/** Default timeout per download attempt; files are larger than query pages. */
export const defaultDownloadTimeoutMs = 120_000;

/**
 * Files are only fetched over HTTPS from ft.dk or its subdomains. The same
 * rule applies to the final URL after redirects.
 */
function isFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === "https:" &&
    (host === "ft.dk" || host.endsWith(".ft.dk"))
  );
}

/**
 * Reads the body, stopping and cancelling it as soon as it exceeds
 * `maxBytes`. A `Content-Length` above the limit fails before reading.
 */
async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new OdaFileTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new OdaFileTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Returns the bytes of the file at `url`. Throws `OdaFileTooLargeError`
 * (not retried) if it is larger than `maxBytes`, and `OdaError` otherwise.
 */
export async function downloadFile(
  url: string,
  maxBytes: number = defaultMaxFileBytes,
  options: OdaRequestOptions = {},
): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes < 0)
    throw new OdaError(odaFailureReasons.invalidQuery);
  if (!isFileUrl(url)) throw new OdaError(odaFailureReasons.invalidUrl);
  return odaRequest(
    url,
    (response) => readLimited(response, maxBytes),
    {
      timeoutMs: defaultDownloadTimeoutMs,
      ...options,
    },
    "*/*",
    isFileUrl,
  );
}
