import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultMaxFileBytes,
  downloadFile,
  odaFailureReasons,
  OdaError,
  OdaFileTooLargeError,
  odaUserAgent,
} from "@/lib/oda";
import { mockFetch, redirectedTo, statusResponse } from "@/tests/support/oda";

// A real Fil.filurl from the L 211 fixture: a DOCX served from a .pdf URL.
const fileUrl =
  "https://www.ft.dk/samling/20241/lovforslag/l211/bilag/1/3008206.pdf";

let fetchMock: ReturnType<typeof mockFetch>;

beforeEach(() => {
  fetchMock = mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A response that streams `chunks` chunks of `chunkSize` bytes and records
 * how many were pulled and whether the stream was cancelled.
 */
function streamingResponse(
  chunks: number,
  chunkSize: number,
  headers: Record<string, string> = {},
) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(chunkSize).fill(state.pulled));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, { headers }), state };
}

describe("downloadFile", () => {
  it("returns the file's bytes", async () => {
    const { response } = streamingResponse(3, 4);
    fetchMock.mockResolvedValueOnce(response);

    const bytes = await downloadFile(fileUrl);

    expect(Array.from(bytes)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect(requestHeaders().get("User-Agent")).toBe(odaUserAgent);
  });

  it("accepts a file of exactly the limit", async () => {
    const { response } = streamingResponse(2, 5);
    fetchMock.mockResolvedValueOnce(response);

    expect((await downloadFile(fileUrl, 10)).byteLength).toBe(10);
  });

  it("stops reading and cancels the body once the limit is exceeded", async () => {
    const { response, state } = streamingResponse(1_000, 1_024);
    fetchMock.mockResolvedValueOnce(response);

    const error = await downloadFile(fileUrl, 4_000).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OdaFileTooLargeError);
    expect(error).toMatchObject({
      reason: odaFailureReasons.fileTooLarge,
      maxBytes: 4_000,
    });
    expect(state.cancelled).toBe(true);
    // 4 KB fit in four chunks; the fifth exceeds the limit. The stream may
    // have queued one more chunk ahead, but never the whole body.
    expect(state.pulled).toBeLessThanOrEqual(6);
    // Too large is final: no retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails before reading when Content-Length is above the limit", async () => {
    const { response, state } = streamingResponse(10, 1_000, {
      "Content-Length": "10000",
    });
    fetchMock.mockResolvedValueOnce(response);

    await expect(downloadFile(fileUrl, 9_999)).rejects.toBeInstanceOf(
      OdaFileTooLargeError,
    );
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it("defaults to a 25 MB limit", () => {
    expect(defaultMaxFileBytes).toBe(25 * 1024 * 1024);
  });

  it("retries a 503 and then returns the bytes", async () => {
    const { response } = streamingResponse(1, 3);
    fetchMock
      .mockResolvedValueOnce(statusResponse(503))
      .mockResolvedValueOnce(response);

    const bytes = await downloadFile(fileUrl, undefined, { retryDelayMs: 1 });

    expect(bytes.byteLength).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts a redirect to another ft.dk host", async () => {
    const { response } = streamingResponse(1, 3);
    fetchMock.mockResolvedValueOnce(
      redirectedTo(response, "https://files.ft.dk/3008206.pdf"),
    );

    expect((await downloadFile(fileUrl)).byteLength).toBe(3);
  });

  it.each(["https://example.com/3008206.pdf", "http://www.ft.dk/3008206.pdf"])(
    "rejects a redirect to %s, cancels the body and does not retry",
    async (url) => {
      const { response, state } = streamingResponse(10, 1_000);
      fetchMock.mockResolvedValue(redirectedTo(response, url));

      const error = await downloadFile(fileUrl, undefined, {
        retryDelayMs: 1,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(OdaError);
      expect((error as OdaError).reason).toBe(odaFailureReasons.invalidUrl);
      expect(state.cancelled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "http://www.ft.dk/file.pdf",
    "https://example.com/file.pdf",
    "https://ft.dk.example.com/file.pdf",
    "not a url",
  ])("refuses %s without a request", async (url) => {
    const error = await downloadFile(url).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OdaError);
    expect((error as OdaError).reason).toBe(odaFailureReasons.invalidUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function requestHeaders(): Headers {
  return new Headers(fetchMock.mock.calls[0][1]?.headers);
}
