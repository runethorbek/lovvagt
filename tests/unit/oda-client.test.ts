import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSag,
  fetchStemme,
  odaBaseUrl,
  odaFailureReasons,
  OdaError,
  odaFetchAll,
  odaPages,
  odaQueryUrl,
  odaUserAgent,
} from "@/lib/oda";
import {
  hangingFetch,
  jsonResponse,
  mockFetch,
  odaFixture,
  odaFixtureText,
  redirectedTo,
  requestedUrls,
  statusResponse,
} from "@/tests/support/oda";

// Fast retries for tests: the backoff is 1 ms, 2 ms, ...
const fast = { retryDelayMs: 1 };

let fetchMock: ReturnType<typeof mockFetch>;

beforeEach(() => {
  fetchMock = mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Asserts `promise` rejects with an `OdaError` with the given reason. */
async function expectOdaError(
  promise: Promise<unknown>,
  reason: string,
): Promise<OdaError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OdaError);
  const odaError = error as OdaError;
  expect(odaError.reason).toBe(reason);
  expect(odaError.message).toBe(`ODA request failed: ${reason}`);
  expect(odaError.cause).toBeUndefined();
  return odaError;
}

describe("odaQueryUrl", () => {
  it("adds $format=json and percent-encodes the entity and values", () => {
    expect(
      odaQueryUrl("SagAktør", {
        filter: "rolle eq 'Ministerområde' and sagid eq 1",
        expand: "SagAktørRolle",
        orderby: "opdateringsdato",
        top: 100,
      }),
    ).toBe(
      `${odaBaseUrl}/SagAkt%C3%B8r?$filter=rolle%20eq%20'Ministeromr%C3%A5de'%20and%20sagid%20eq%201&$expand=SagAkt%C3%B8rRolle&$orderby=opdateringsdato&$top=100&$format=json`,
    );
  });

  it("keeps navigation paths readable", () => {
    expect(
      odaQueryUrl("Afstemning", { filter: "Sagstrin/sagid eq 101039" }),
    ).toBe(
      `${odaBaseUrl}/Afstemning?$filter=Sagstrin/sagid%20eq%20101039&$format=json`,
    );
  });

  it("adds only $format=json without a query", () => {
    expect(odaQueryUrl("Periode")).toBe(`${odaBaseUrl}/Periode?$format=json`);
  });

  it.each([0, 101, 1.5])("rejects $top %s", (top) => {
    expect(() => odaQueryUrl("Sag", { top })).toThrow(
      new OdaError(odaFailureReasons.invalidQuery),
    );
  });
});

describe("requests", () => {
  it("sends a generic User-Agent with no contact details", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(odaFixtureText("sag-101687")));

    await fetchSag({ filter: "id eq 101687" });

    const init = fetchMock.mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get("User-Agent")).toBe(odaUserAgent);
    expect(odaUserAgent).not.toMatch(/@|https?:|mailto/i);
    expect(headers.get("Accept")).toBe("application/json");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("makes one request at a time, even for concurrent callers", async () => {
    let releaseFirst!: () => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () =>
              resolve(jsonResponse(odaFixtureText("sag-101687")));
          }),
      )
      .mockResolvedValueOnce(jsonResponse(odaFixtureText("sag-101039")));

    const first = fetchSag({ filter: "id eq 101687" });
    const second = fetchSag({ filter: "id eq 101039" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a[0].id).toBe(101687);
    expect(b[0].id).toBe(101039);
  });
});

describe("redirects", () => {
  it("accepts a final URL on the ODA API", async () => {
    fetchMock.mockResolvedValueOnce(
      redirectedTo(
        jsonResponse(odaFixtureText("sag-101687")),
        `${odaBaseUrl}/Sag?$format=json`,
      ),
    );

    expect(await fetchSag()).toHaveLength(1);
  });

  it.each([
    ["another host", "https://example.com/api/Sag?$format=json"],
    ["plain HTTP", `${odaBaseUrl.replace("https:", "http:")}/Sag`],
  ])("rejects a redirect to %s without retrying", async (_, url) => {
    fetchMock.mockResolvedValue(
      redirectedTo(jsonResponse(odaFixtureText("sag-101687")), url),
    );

    await expectOdaError(fetchSag({}, fast), odaFailureReasons.invalidUrl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("paging", () => {
  it("follows odata.nextLink until the last page", async () => {
    const page1 = odaFixture("stemme-10204-p1");
    const page2 = odaFixture("stemme-10204-p2");
    expect(page1["odata.nextLink"]).toBeDefined();
    expect(page2["odata.nextLink"]).toBeUndefined();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(odaFixtureText("stemme-10204-p1")))
      .mockResolvedValueOnce(jsonResponse(odaFixtureText("stemme-10204-p2")));

    const stemmer = await fetchStemme({ filter: "afstemningid eq 10204" });

    expect(requestedUrls(fetchMock)).toEqual([
      `${odaBaseUrl}/Stemme?$filter=afstemningid%20eq%2010204&$format=json`,
      page1["odata.nextLink"],
    ]);
    expect(stemmer.map((s) => s.id)).toEqual([
      ...page1.value.map((row) => row.id),
      ...page2.value.map((row) => row.id),
    ]);
  });

  it("follows the nextLink of a recorded Sag page", async () => {
    const page1 = odaFixture("sag-paged-p1");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(odaFixtureText("sag-paged-p1")))
      .mockResolvedValueOnce(jsonResponse(odaFixtureText("sag-101687")));

    const sager = await fetchSag({
      filter: "typeid eq 3 and periodeid eq 163",
    });

    expect(requestedUrls(fetchMock)[1]).toBe(page1["odata.nextLink"]);
    expect(sager).toHaveLength(page1.value.length + 1);
  });

  it("yields one array per page", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(odaFixtureText("stemme-10204-p1")))
      .mockResolvedValueOnce(jsonResponse(odaFixtureText("stemme-10204-p2")));

    const sizes: number[] = [];
    for await (const page of odaPages("Stemme", {}, (row) => row))
      sizes.push(page.length);

    expect(sizes).toEqual([
      odaFixture("stemme-10204-p1").value.length,
      odaFixture("stemme-10204-p2").value.length,
    ]);
  });

  it("adds $format=json to a nextLink without it", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          JSON.stringify({
            value: [],
            "odata.nextLink": `${odaBaseUrl}/Sag?$skip=100`,
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ value: [] })));

    await odaFetchAll("Sag", {}, (row) => row);

    expect(requestedUrls(fetchMock)[1]).toBe(
      `${odaBaseUrl}/Sag?$skip=100&$format=json`,
    );
  });

  it.each([
    ["another host", "https://example.com/api/Sag?$skip=100"],
    ["plain HTTP", `${odaBaseUrl.replace("https:", "http:")}/Sag?$skip=100`],
    ["not a URL", "not a url"],
  ])("refuses a nextLink to %s", async (_, link) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(JSON.stringify({ value: [], "odata.nextLink": link })),
    );

    await expectOdaError(
      odaFetchAll("Sag", {}, (row) => row),
      odaFailureReasons.invalidResponse,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops on a nextLink that repeats a page", async () => {
    const first = odaQueryUrl("Sag");
    fetchMock.mockImplementation(async () =>
      jsonResponse(JSON.stringify({ value: [], "odata.nextLink": first })),
    );

    await expectOdaError(
      odaFetchAll("Sag", {}, (row) => row),
      odaFailureReasons.invalidResponse,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("retries", () => {
  it.each([503, 429, 500])(
    "retries after HTTP %s and succeeds",
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(statusResponse(status))
        .mockResolvedValueOnce(jsonResponse(odaFixtureText("sag-101687")));

      const sager = await fetchSag({}, fast);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sager[0].id).toBe(101687);
    },
  );

  it("retries after a network error and succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(odaFixtureText("sag-101687")));

    await fetchSag({}, fast);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on HTTP 503 after maxAttempts", async () => {
    fetchMock.mockImplementation(async () => statusResponse(503));

    const error = await expectOdaError(
      fetchSag({}, { ...fast, maxAttempts: 3 }),
      odaFailureReasons.serverError,
    );
    expect(error.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up on HTTP 429 after the default number of attempts", async () => {
    fetchMock.mockImplementation(async () => statusResponse(429));

    const error = await expectOdaError(
      fetchSag({}, fast),
      odaFailureReasons.rateLimited,
    );
    expect(error.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives up on network errors after maxAttempts", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: secret detail"));

    const error = await expectOdaError(
      fetchSag({}, { ...fast, maxAttempts: 2 }),
      odaFailureReasons.network,
    );
    expect(error.message).not.toContain("secret detail");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry other HTTP errors", async () => {
    fetchMock.mockResolvedValue(statusResponse(404));

    const error = await expectOdaError(
      fetchSag({}, fast),
      odaFailureReasons.httpError,
    );
    expect(error.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("timeouts and aborts", () => {
  it("stops a request that exceeds the timeout", async () => {
    fetchMock.mockImplementation(hangingFetch);

    await expectOdaError(
      fetchSag({}, { timeoutMs: 20, maxAttempts: 1 }),
      odaFailureReasons.timeout,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("retries a timed-out request within the attempt limit", async () => {
    fetchMock
      .mockImplementationOnce(hangingFetch)
      .mockResolvedValueOnce(jsonResponse(odaFixtureText("sag-101687")));

    const sager = await fetchSag({}, { ...fast, timeoutMs: 20 });

    expect(sager).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops a request when the caller aborts, without retrying", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((url, init) => {
      setTimeout(() => controller.abort(), 5);
      return hangingFetch(url, init);
    });

    await expectOdaError(
      fetchSag({}, { ...fast, signal: controller.signal }),
      odaFailureReasons.aborted,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("does not start a request when already aborted", async () => {
    await expectOdaError(
      fetchSag({}, { signal: AbortSignal.abort() }),
      odaFailureReasons.aborted,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops waiting for a retry when the caller aborts", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      setTimeout(() => controller.abort(), 5);
      return statusResponse(503);
    });

    const started = performance.now();
    await expectOdaError(
      fetchSag({}, { retryDelayMs: 60_000, signal: controller.signal }),
      odaFailureReasons.aborted,
    );
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops paging when the caller aborts between pages", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(odaFixtureText("stemme-10204-p1")),
    );

    const pages = odaPages("Stemme", {}, (row) => row, {
      signal: controller.signal,
    });
    await pages.next();
    controller.abort();

    await expectOdaError(pages.next(), odaFailureReasons.aborted);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("invalid responses", () => {
  const secret = "SECRET-RESPONSE-TEXT-1234";

  function expectNoResponseText(error: OdaError) {
    for (const text of [error.message, String(error), error.stack ?? ""])
      expect(text).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  }

  it("rejects invalid JSON without passing the text on", async () => {
    fetchMock.mockResolvedValue(jsonResponse(`{"value": [${secret}`));

    const error = await expectOdaError(
      fetchSag({}, fast),
      odaFailureReasons.invalidJson,
    );
    expectNoResponseText(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a response without a value array", async () => {
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify({ secret })));

    const error = await expectOdaError(
      fetchSag(),
      odaFailureReasons.invalidResponse,
    );
    expectNoResponseText(error);
  });

  it("rejects a row that does not match the schema", async () => {
    const page = odaFixture("sag-101687");
    page.value[0] = { ...page.value[0], titel: 42, nummer: secret };
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify(page)));

    const error = await expectOdaError(
      fetchSag(),
      odaFailureReasons.invalidResponse,
    );
    expectNoResponseText(error);
  });

  it("rejects a row with an invalid timestamp", async () => {
    const page = odaFixture("sag-101687");
    page.value[0] = { ...page.value[0], opdateringsdato: secret };
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify(page)));

    const error = await expectOdaError(
      fetchSag(),
      odaFailureReasons.invalidResponse,
    );
    expectNoResponseText(error);
  });

  it("rejects a row that is not an object", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(JSON.stringify({ value: [secret] })),
    );

    await expectOdaError(fetchSag(), odaFailureReasons.invalidResponse);
  });
});
