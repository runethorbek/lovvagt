/**
 * Ingest steps 1 and 2 (spec 002, deliverable 4) with the ODA client mocked
 * by recorded fixtures and the database on the SQL test harness.
 *
 * The mocked ODA serves the seven 2024-25 fixture bills (six candidates and
 * L 31) in session 163 and no bills in the other sessions. It answers the
 * step's filters on session, Sag id and Aktør id, and ignores the
 * `opdateringsdato` filter, so a second run sees the same data.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  IngestError,
  ingestBills,
  ingestErrors,
  ingestSessions,
  type BillsResult,
} from "@/lib/ingest/steps";
import {
  jsonResponse,
  mockFetch,
  odaFixture,
  requestedUrls,
  statusResponse,
} from "@/tests/support/oda";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "@/tests/support/pglite";

const billIds = [69354, 99215, 101039, 101043, 101403, 101687, 101688];
const candidateIds = [69354, 101039, 101043, 101403, 101687, 101688];

/** Expected `tracked_sag` rows (topic tests in `topics.test.ts`). */
const expectedTracked = [
  "69354:security",
  "101039:ai",
  "101043:ai",
  "101403:defence",
  "101687:defence",
  "101687:security",
  "101688:defence",
];

type Row = Record<string, unknown>;

const sagRows = billIds.map((id) => odaFixture(`sag-${id}`).value[0]);
const roles = new Map(
  odaFixture("sagaktoerrolle").value.map((row) => [row.id, row]),
);
// SagAktør rows as fetched with `$expand=SagAktørRolle`.
const sagAktoerRows: Row[] = billIds.flatMap((id) =>
  odaFixture(`sagaktoer-${id}`).value.map((row) => ({
    ...row,
    SagAktørRolle: roles.get(row.rolleid),
  })),
);
const emneordSagRows = billIds.flatMap(
  (id) => odaFixture(`emneordsag-${id}`).value,
);
const aktoerRows = [
  ...new Map(
    [
      ...odaFixture("aktoer-ministerier").value,
      ...odaFixture("aktoer-referenced").value,
    ].map((row) => [row.id, row]),
  ).values(),
];

function entityOf(url: URL): string | undefined {
  return decodeURIComponent(url.pathname).split("/").pop();
}

function filterOf(url: URL): string {
  return url.searchParams.get("$filter") ?? "";
}

function number(filter: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(filter);
  return match ? Number(match[1]) : undefined;
}

/** Rows of a bill in session 163 within the filter's `sagid` range. */
function inSagRange(rows: Row[], filter: string): Row[] {
  if (number(filter, /Sag\/periodeid eq (\d+)/) !== 163) return [];
  const min = number(filter, /sagid ge (\d+)/) ?? 0;
  const max = number(filter, /sagid le (\d+)/) ?? Infinity;
  return rows.filter((row) => {
    const sagid = Number(row.sagid);
    return sagid >= min && sagid <= max;
  });
}

/** Answers the step's queries from the fixtures. */
function odaResponse(text: string): Response {
  const url = new URL(text);
  const entity = entityOf(url);
  const filter = filterOf(url);
  let value: Row[];
  switch (entity) {
    case "Periode":
      value = odaFixture("periode-samling").value;
      break;
    case "Sag": {
      const session = number(filter, /periodeid eq (\d+)/);
      const after = number(filter, /id gt (\d+)/) ?? 0;
      const top = Math.min(
        Number(url.searchParams.get("$top") ?? 100),
        serverPageSize,
      );
      value = (session === 163 ? sagRows : [])
        .filter((row) => Number(row.id) > after)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, top);
      break;
    }
    case "SagAktør":
      value = inSagRange(sagAktoerRows, filter);
      break;
    case "EmneordSag":
      value = inSagRange(emneordSagRows, filter);
      break;
    case "Aktør": {
      const ids = new Set(
        [...filter.matchAll(/id eq (\d+)/g)].map((m) => Number(m[1])),
      );
      value = aktoerRows.filter((row) => ids.has(Number(row.id)));
      break;
    }
    default:
      throw new Error(`unexpected ODA query: ${text}`);
  }
  return jsonResponse(JSON.stringify({ value }));
}

/** Rows per Sag page that the mocked server returns at most, below `$top`. */
let serverPageSize = Infinity;

let database: TestDatabase;
let fetchMock: ReturnType<typeof mockFetch>;

beforeAll(async () => {
  database = await createMigratedTestDatabase();
}, 30_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.pg.exec(
    "TRUNCATE tracked_sag, sag, periode, aktoer, sag_aktoer, emneord, emneord_sag",
  );
  serverPageSize = Infinity;
  fetchMock = mockFetch();
  fetchMock.mockImplementation(async (url) => odaResponse(String(url)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function ids(table: string): Promise<number[]> {
  const rows = await database.sql.query(`SELECT id FROM ${table} ORDER BY id`);
  return rows.map((row) => Number(row.id));
}

async function tracked(): Promise<string[]> {
  const rows = await database.sql.query(
    "SELECT sag_id, topic FROM tracked_sag WHERE matching ORDER BY sag_id, topic",
  );
  return rows.map((row) => `${row.sag_id}:${row.topic}`);
}

/** Every stored row with its `xmin`, which changes on every write. */
async function snapshot(): Promise<string[]> {
  const tables = ["sag", "sag_aktoer", "aktoer", "emneord", "emneord_sag"];
  const rows: string[] = [];
  for (const table of tables)
    for (const row of await database.sql.query(
      `SELECT id, xmin::text AS xmin FROM ${table} ORDER BY id`,
    ))
      rows.push(`${table}:${row.id}:${row.xmin}`);
  for (const row of await database.sql.query(
    "SELECT sag_id, topic, xmin::text AS xmin FROM tracked_sag ORDER BY sag_id, topic",
  ))
    rows.push(`tracked_sag:${row.sag_id}:${row.topic}:${row.xmin}`);
  return rows;
}

function totals(result: BillsResult) {
  return Object.fromEntries(
    Object.entries(result.counts).map(([entity, counts]) => [
      entity,
      { inserted: counts.inserted, updated: counts.updated },
    ]),
  );
}

async function runSessions() {
  const result = await ingestSessions(database.sql);
  expect(result.done).toBe(true);
}

/** The ids of the expected stored Aktør rows: referenced and in the fixtures. */
function expectedAktoerIds(): number[] {
  const referenced = new Set(
    sagAktoerRows
      .filter((row) => candidateIds.includes(Number(row.sagid)))
      .map((row) => Number(row.aktørid)),
  );
  return aktoerRows
    .map((row) => Number(row.id))
    .filter((id) => referenced.has(id))
    .sort((a, b) => a - b);
}

describe("ingestSessions", () => {
  it("upserts the sessions from 2024-10-01 and writes nothing the second time", async () => {
    const first = await ingestSessions(database.sql);
    expect(first).toEqual({
      done: true,
      counts: {
        periode: { fetched: 4, inserted: 4, updated: 0, unchanged: 0 },
      },
    });
    expect(await ids("periode")).toEqual([163, 165, 167, 168]);
    expect(requestedUrls(fetchMock)[0]).toContain(
      "$filter=type%20eq%20'samling'%20and%20startdato%20ge%20datetime'2024-10-01T00:00:00'",
    );

    const second = await ingestSessions(database.sql);
    expect(second.counts.periode).toEqual({
      fetched: 4,
      inserted: 0,
      updated: 0,
      unchanged: 4,
    });
  });

  it("does not start after the deadline", async () => {
    const result = await ingestSessions(database.sql, {
      deadline: 1000,
      now: () => 1000,
    });
    expect(result.done).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails with a fixed message when ODA fails", async () => {
    fetchMock.mockImplementation(async () => statusResponse(404));
    await expect(ingestSessions(database.sql)).rejects.toThrow(
      new IngestError(ingestErrors.oda),
    );
  });
});

describe("ingestBills", () => {
  beforeEach(runSessions);

  it("stores exactly the candidates on a first run", async () => {
    const result = await ingestBills(database.sql);
    expect(result.done).toBe(true);

    expect(await ids("sag")).toEqual(candidateIds);
    expect(await tracked()).toEqual(expectedTracked);
    const sagAktoerIds = sagAktoerRows
      .filter((row) => candidateIds.includes(Number(row.sagid)))
      .map((row) => Number(row.id))
      .sort((a, b) => a - b);
    expect(await ids("sag_aktoer")).toEqual(sagAktoerIds);
    const emneordSag = emneordSagRows.filter((row) =>
      candidateIds.includes(Number(row.sagid)),
    );
    expect(await ids("emneord_sag")).toEqual(
      emneordSag.map((row) => Number(row.id)).sort((a, b) => a - b),
    );
    expect(await ids("emneord")).toEqual(
      [...new Set(emneordSag.map((row) => Number(row.emneordid)))].sort(
        (a, b) => a - b,
      ),
    );
    expect(await ids("aktoer")).toEqual(expectedAktoerIds());
    // L 31's ministry (Skatteministeriet, Aktør 204) is not stored.
    expect(await ids("aktoer")).not.toContain(204);

    const [rolle] = await database.sql.query(
      "SELECT rolle, raw FROM sag_aktoer WHERE id = 1822263",
    );
    expect(rolle.rolle).toBe("Ministerområde");
    expect(rolle.raw).not.toHaveProperty("SagAktørRolle");

    expect(result.counts).toEqual({
      sag: { fetched: 7, inserted: 6, updated: 0, unchanged: 0 },
      sag_aktoer: { fetched: 28, inserted: 24, updated: 0, unchanged: 0 },
      aktoer: {
        fetched: expect.any(Number),
        inserted: expectedAktoerIds().length,
        updated: 0,
        unchanged: 0,
      },
      emneord: { fetched: 14, inserted: 12, updated: 0, unchanged: 0 },
      emneord_sag: { fetched: 14, inserted: 12, updated: 0, unchanged: 0 },
      tracked_sag: { fetched: 18, inserted: 7, updated: 0, unchanged: 0 },
    });

    // Highest Sag opdateringsdato: L 152, 2025-09-30T11:10:02.51 local.
    if (!result.done) throw new Error("not done");
    expect(result.watermark?.toISOString()).toBe("2025-09-30T09:10:02.510Z");
  });

  it("queries bills in sessions from step 1, with no watermark filter on a first run", async () => {
    await ingestBills(database.sql);
    const sagUrls = requestedUrls(fetchMock)
      .map((text) => new URL(text))
      .filter((url) => entityOf(url) === "Sag");
    expect(sagUrls.map(filterOf)).toEqual([
      "typeid eq 3 and periodeid eq 163 and id gt 0",
      "typeid eq 3 and periodeid eq 163 and id gt 101688",
      "typeid eq 3 and periodeid eq 165 and id gt 0",
      "typeid eq 3 and periodeid eq 167 and id gt 0",
      "typeid eq 3 and periodeid eq 168 and id gt 0",
    ]);
    expect(sagUrls[0].searchParams.get("$orderby")).toBe("id");
  });

  it("reports zero inserts and updates on a second run with the same data", async () => {
    const first = await ingestBills(database.sql);
    if (!first.done) throw new Error("not done");
    const before = await snapshot();
    fetchMock.mockClear();

    const second = await ingestBills(database.sql, {
      since: first.watermark ?? undefined,
    });
    expect(second.done).toBe(true);
    for (const counts of Object.values(totals(second)))
      expect(counts).toEqual({ inserted: 0, updated: 0 });
    expect(second.counts.sag.unchanged).toBe(6);
    expect(second.counts.tracked_sag.unchanged).toBe(7);
    expect(await snapshot()).toEqual(before);
    if (!second.done) throw new Error("not done");
    expect(second.watermark).toEqual(first.watermark);

    // The query starts one hour before the watermark, in local time.
    const urls = requestedUrls(fetchMock).map((text) => new URL(text));
    const sag = urls.find((url) => entityOf(url) === "Sag");
    expect(sag && filterOf(sag)).toBe(
      "typeid eq 3 and periodeid eq 163 and opdateringsdato gt datetime'2025-09-30T10:10:02' and id gt 0",
    );
    const sagAktoer = urls.find((url) => entityOf(url) === "SagAktør");
    expect(sagAktoer && filterOf(sagAktoer)).toBe(
      "sagid ge 69354 and sagid le 101688 and Sag/typeid eq 3 and Sag/periodeid eq 163 and Sag/opdateringsdato gt datetime'2025-09-30T10:10:02'",
    );
  });

  it("caps the watermark at the step's start and never moves it back", async () => {
    // Started before L 152's change (2025-09-30): the watermark is the start.
    const capped = await ingestBills(database.sql, {
      now: () => Date.parse("2025-08-01T00:00:00.000Z"),
    });
    if (!capped.done) throw new Error("not done");
    expect(capped.watermark?.toISOString()).toBe("2025-08-01T00:00:00.000Z");

    // A stored watermark later than anything fetched is kept.
    const later = new Date("2026-11-01T00:00:00.000Z");
    const kept = await ingestBills(database.sql, { since: later });
    if (!kept.done) throw new Error("not done");
    expect(kept.watermark).toEqual(later);
  });

  it("stops at the deadline with progress that a second call completes without duplicates", async () => {
    let clock = Date.now();
    const now = () => clock;
    // Pages of three bills: 69354, 99215, 101039 | 101043, 101403, 101687 | 101688.
    fetchMock.mockImplementation(async (url) => {
      const response = odaResponse(String(url));
      if (entityOf(new URL(String(url))) === "Sag") clock += 1;
      return response;
    });
    const first = await ingestBills(database.sql, {
      pageSize: 3,
      deadline: clock + 1,
      now,
    });
    expect(first.done).toBe(false);
    if (first.done) throw new Error("done");
    expect(first.cursor).toMatchObject({
      sessionIds: [163, 165, 167, 168],
      sessionIndex: 0,
      afterId: 101039,
      highest: "2025-05-15T07:07:48.770Z",
    });
    expect(await ids("sag")).toEqual([69354, 101039]);
    expect(first.counts.sag).toEqual({
      fetched: 3,
      inserted: 2,
      updated: 0,
      unchanged: 0,
    });

    // The cursor survives a round trip through JSON (e.g. a database row).
    const cursor = JSON.parse(JSON.stringify(first.cursor));
    const second = await ingestBills(database.sql, { pageSize: 3, cursor });
    expect(second.done).toBe(true);
    if (!second.done) throw new Error("not done");
    expect(second.counts.sag).toEqual({
      fetched: 4,
      inserted: 4,
      updated: 0,
      unchanged: 0,
    });
    expect(second.watermark?.toISOString()).toBe("2025-09-30T09:10:02.510Z");
    expect(await ids("sag")).toEqual(candidateIds);
    expect(await tracked()).toEqual(expectedTracked);

    // The two calls together inserted exactly what one run would.
    const inserted = (entity: keyof typeof first.counts) =>
      first.counts[entity].inserted + second.counts[entity].inserted;
    expect(inserted("tracked_sag")).toBe(7);
    expect(inserted("sag_aktoer")).toBe(24);
    expect(inserted("emneord_sag")).toBe(12);
    const [{ count }] = await database.sql.query(
      "SELECT count(*)::int AS count FROM sag_aktoer",
    );
    expect(count).toBe(24);
  });

  it("continues a session after a page shorter than requested", async () => {
    // The server returns two rows per page although $top asks for three.
    serverPageSize = 2;
    const result = await ingestBills(database.sql, { pageSize: 3 });
    expect(result.done).toBe(true);
    expect(await ids("sag")).toEqual(candidateIds);
    expect(await tracked()).toEqual(expectedTracked);
    const afterIds = requestedUrls(fetchMock)
      .map((text) => new URL(text))
      .filter((url) => entityOf(url) === "Sag")
      .map(filterOf)
      .filter((filter) => filter.includes("periodeid eq 163"))
      .map((filter) => /id gt (\d+)/.exec(filter)?.[1]);
    expect(afterIds).toEqual(["0", "99215", "101043", "101687", "101688"]);
  });

  it("returns its cursor unchanged when the signal stops a unit mid-way", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (url) => {
      if (entityOf(new URL(String(url))) === "EmneordSag") controller.abort();
      return odaResponse(String(url));
    });
    const first = await ingestBills(database.sql, {
      signal: controller.signal,
    });
    expect(first.done).toBe(false);
    if (first.done) throw new Error("done");
    expect(first.cursor).toMatchObject({ sessionIndex: 0, afterId: 0 });
    expect(await ids("sag")).toEqual([]);

    fetchMock.mockImplementation(async (url) => odaResponse(String(url)));
    const second = await ingestBills(database.sql, { cursor: first.cursor });
    expect(second.done).toBe(true);
    expect(await ids("sag")).toEqual(candidateIds);
  });

  it("keeps a tracked bill that stops matching, with matching = false", async () => {
    await ingestBills(database.sql);
    // L 210 (101688) matches defence only through "Forsvarets" in its
    // texts. Simulate ODA changing them.
    const index = sagRows.findIndex((row) => row.id === 101688);
    const original = sagRows[index];
    sagRows[index] = {
      ...original,
      titel: "Changed title",
      titelkort: "Changed",
      resume: null,
      opdateringsdato: "2026-11-20T10:00:00",
    };
    try {
      const result = await ingestBills(database.sql);
      expect(result.counts.sag).toMatchObject({ updated: 1, unchanged: 5 });
      expect(result.counts.tracked_sag).toMatchObject({
        inserted: 0,
        updated: 1,
        unchanged: 6,
      });
    } finally {
      sagRows[index] = original;
    }
    expect(await ids("sag")).toContain(101688);
    const [row] = await database.sql.query(
      "SELECT matching, matched_rules FROM tracked_sag WHERE sag_id = 101688 AND topic = 'defence'",
    );
    expect(row).toEqual({ matching: false, matched_rules: [] });
    expect(
      await database.sql.query(
        "SELECT count(*)::int AS count FROM sag_aktoer WHERE sagid = 101688",
      ),
    ).toEqual([{ count: 4 }]);
  });

  it("fails with a fixed message when ODA fails", async () => {
    fetchMock.mockImplementation(async () => statusResponse(400));
    await expect(ingestBills(database.sql)).rejects.toThrow(
      new IngestError(ingestErrors.oda),
    );
  });

  it("fails with a fixed message when the database fails", async () => {
    const failing = {
      ...database.sql,
      query: async () => {
        throw new Error("driver text with secrets");
      },
    };
    await expect(ingestBills(failing)).rejects.toThrow(
      new IngestError(ingestErrors.database),
    );
  });
});
