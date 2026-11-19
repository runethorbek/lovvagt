/**
 * Helpers for ODA client tests: recorded fixtures from `tests/fixtures/oda/`
 * and a mocked `fetch`. No test may reach the real ODA API.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

const fixturesDirectory = join(import.meta.dirname, "..", "fixtures", "oda");

/** The text of a recorded ODA response, e.g. `odaFixtureText("sag-101687")`. */
export function odaFixtureText(name: string): string {
  return readFileSync(join(fixturesDirectory, `${name}.json`), "utf8");
}

/** A recorded ODA response, parsed. */
export function odaFixture(name: string): {
  value: Record<string, unknown>[];
  "odata.nextLink"?: string;
} {
  return JSON.parse(odaFixtureText(name));
}

/** A JSON response with the given body text. */
export function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** An empty response with the given status. */
export function statusResponse(status: number): Response {
  return new Response(null, { status });
}

/**
 * A `fetch` that never answers: it rejects only when the request's signal
 * aborts, the way the real `fetch` does.
 */
export function hangingFetch(url: string, init?: RequestInit) {
  void url;
  return new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** Replaces the global `fetch` with a mock. Undefined calls fail loudly. */
export function mockFetch() {
  const fetchMock = vi.fn<
    (url: string, init?: RequestInit) => Promise<Response>
  >(async () => {
    throw new Error("unexpected network access in unit test");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The URLs requested from a fetch mock, in order. */
export function requestedUrls(
  fetchMock: ReturnType<typeof mockFetch>,
): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}
