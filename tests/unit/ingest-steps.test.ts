/**
 * Ingest steps (spec 002, deliverable 4) with the ODA client mocked by
 * recorded fixtures and the database on the SQL test harness.
 *
 * The mocked ODA serves the seven 2024-25 fixture bills (six candidates and
 * L 31) in session 163 and no bills in the other sessions, and the children
 * of L 211 and L 154. It answers the steps' filters on session, ids, `id gt`
 * and `$top`. For the bills step it ignores the `opdateringsdato` filter, so
 * a second run sees the same data. For the changed-since queries of the
 * links and children steps it applies it, as ODA does.
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
  ingestChildren,
  ingestErrors,
  ingestLinks,
  ingestSessions,
  type BillsResult,
  type ChildrenResult,
  type ChildrenWatermarks,
} from "@/lib/ingest/steps";
import { formatOdaTimestamp, tryParseOdaTimestamp } from "@/lib/oda";
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
// Emneord rows by id, from the recorded EmneordSag expansions. EmneordSag
// responses nest the current row from here, so a change shows in both.
const emneordById = new Map<unknown, Row>(
  emneordSagRows.map((row) => [row.emneordid, row.Emneord as Row]),
);
const aktoerRows = [
  ...new Map(
    [
      ...odaFixture("aktoer-ministerier").value,
      ...odaFixture("aktoer-referenced").value,
    ].map((row) => [row.id, row]),
  ).values(),
];

const lookup = (name: string) =>
  new Map(odaFixture(name).value.map((row) => [row.id, row]));
const sagDokumentRoller = lookup("sagdokumentrolle");
const dokumenttyper = lookup("dokumenttype");
const stemmetyper = lookup("stemmetype");

// Children of L 211 and L 154 (L 211 has no vote). Sagstrin rows are
// recorded with `$expand=Sagstrinstype`.
const sagstrinRows: Row[] = [101039, 101687].flatMap(
  (id) => odaFixture(`sagstrin-${id}`).value,
);
const afstemningRows: Row[] = [101039, 101687].flatMap(
  (id) => odaFixture(`afstemning-${id}`).value,
);
// SagDokument rows are recorded with `Dokument/Fil` expanded: split them
// into SagDokument, Dokument and Fil rows.
const recordedSagDokument = [101039, 101687].flatMap(
  (id) => odaFixture(`sagdokument-${id}`).value,
);
const sagDokumentRows: Row[] = recordedSagDokument.map((row) => {
  const { Dokument: dokument, ...rest } = row;
  void dokument;
  return rest;
});
const dokumentRows: Row[] = recordedSagDokument.map((row) => {
  const { Fil: fil, ...rest } = row.Dokument as Row;
  void fil;
  return rest;
});
const filRows: Row[] = recordedSagDokument.flatMap(
  (row) => (row.Dokument as { Fil: Row[] }).Fil,
);
// Vote 10204 (L 154): the recorded first and last Stemme pages.
const stemmePages = ["stemme-10204-p1", "stemme-10204-p2"].map((name) => {
  const page = odaFixture(name);
  return { rows: page.value, nextLink: page["odata.nextLink"] };
});

// Rows changed in test code are restored after each test.
const restores: (() => void)[] = [];

/** Changes a fixture row for one test (a change made in test code). */
function changeRow(rows: Row[], id: number, change: (row: Row) => Row): void {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) throw new Error(`no fixture row ${id}`);
  const original = rows[index];
  rows[index] = change(original);
  restores.push(() => {
    rows[index] = original;
  });
}

/** Adds a row for one test (made in test code from a recorded row). */
function addRow(rows: Row[], row: Row): void {
  rows.push(row);
  restores.push(() => {
    rows.splice(rows.indexOf(row), 1);
  });
}

/** Changes an Emneord row (and so every EmneordSag expansion) for one test. */
function changeEmneord(id: number, change: (row: Row) => Row): void {
  const original = emneordById.get(id);
  if (original === undefined) throw new Error(`no fixture Emneord ${id}`);
  emneordById.set(id, change(original));
  restores.push(() => {
    emneordById.set(id, original);
  });
}

/** Ids in `field eq <id>` terms, not preceded by a letter or `/`. */
function idsIn(filter: string, field: string): number[] {
  const pattern = new RegExp(
    `(?<![\\w/])${field.replace("/", "\\/")} eq (\\d+)`,
    "g",
  );
  return [...filter.matchAll(pattern)].map((match) => Number(match[1]));
}

/** Applies the `opdateringsdato gt`, `id gt` and `$top` of a changed-since query. */
function changedSince(rows: Row[], url: URL): Row[] {
  const filter = filterOf(url);
  const literal = /(?<![\w/])opdateringsdato gt datetime'([^']+)'/.exec(
    filter,
  )?.[1];
  const after =
    literal === undefined ? undefined : tryParseOdaTimestamp(literal);
  if (after === undefined) throw new Error(`no watermark filter: ${filter}`);
  const afterId = number(filter, /(?<![\w/])id gt (\d+)/) ?? 0;
  const top = Number(url.searchParams.get("$top") ?? 100);
  return rows
    .filter(
      (row) =>
        (tryParseOdaTimestamp(String(row.opdateringsdato))?.getTime() ?? 0) >
          after.getTime() && Number(row.id) > afterId,
    )
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, top);
}

/** Rows of bills in scope: Lovforslag in session 163 (all fixture bills). */
function inScope(rows: Row[], filter: string): Row[] {
  return /Sag\/typeid eq 3 and \(Sag\/periodeid eq 163( or Sag\/periodeid eq \d+)*\)/.test(
    filter,
  )
    ? rows
    : [];
}

const withRolle = (row: Row) => ({
  ...row,
  SagAktørRolle: roles.get(row.rolleid),
});
const withEmneord = (row: Row) => ({
  ...row,
  Emneord: emneordById.get(row.emneordid),
});

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
      const sagIds = idsIn(filter, "id");
      if (sagIds.length > 0) {
        // Re-evaluation: bills by id, in scope.
        value = /typeid eq 3 and \(periodeid eq 163[ )]/.test(filter)
          ? sagRows.filter((row) => sagIds.includes(Number(row.id)))
          : [];
        break;
      }
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
    case "EmneordSag": {
      const rows = entity === "SagAktør" ? sagAktoerRows : emneordSagRows;
      const sagIds = idsIn(filter, "sagid");
      value = filter.includes("sagid ge")
        ? inSagRange(rows, filter)
        : sagIds.length > 0
          ? rows.filter((row) => sagIds.includes(Number(row.sagid)))
          : changedSince(inScope(rows, filter), url);
      const expand: (row: Row) => Row =
        entity === "SagAktør" ? withRolle : withEmneord;
      value = value.map(expand);
      break;
    }
    case "Aktør": {
      const ids = new Set(
        [...filter.matchAll(/id eq (\d+)/g)].map((m) => Number(m[1])),
      );
      value =
        ids.size > 0
          ? aktoerRows.filter((row) => ids.has(Number(row.id)))
          : changedSince(aktoerRows, url);
      break;
    }
    case "Emneord":
      value = changedSince([...emneordById.values()], url);
      break;
    case "Sagstrin": {
      const sagIds = idsIn(filter, "sagid");
      value =
        sagIds.length > 0
          ? sagstrinRows.filter((row) => sagIds.includes(Number(row.sagid)))
          : changedSince(inScope(sagstrinRows, filter), url);
      break;
    }
    case "Afstemning": {
      const sagIds = idsIn(filter, "Sagstrin/sagid");
      if (sagIds.length > 0) {
        const stages = new Set(
          sagstrinRows
            .filter((row) => sagIds.includes(Number(row.sagid)))
            .map((row) => row.id),
        );
        value = afstemningRows.filter((row) => stages.has(row.sagstrinid));
      } else value = changedSince(afstemningRows, url);
      break;
    }
    case "Stemme": {
      if (!idsIn(filter, "afstemningid").includes(10204)) {
        value = [];
        break;
      }
      // The recorded pages: the first carries `odata.nextLink`.
      const page = stemmePages[url.searchParams.has("$skip") ? 1 : 0];
      const rows = page.rows.map((row) => ({
        ...row,
        Stemmetype: stemmetyper.get(row.typeid),
      }));
      return jsonResponse(
        JSON.stringify({
          value: rows,
          ...(page.nextLink ? { "odata.nextLink": page.nextLink } : {}),
        }),
      );
    }
    case "SagDokument": {
      const sagIds = idsIn(filter, "sagid");
      value = (
        sagIds.length > 0
          ? sagDokumentRows.filter((row) => sagIds.includes(Number(row.sagid)))
          : changedSince(inScope(sagDokumentRows, filter), url)
      ).map((row) => ({
        ...row,
        SagDokumentRolle: sagDokumentRoller.get(row.rolleid),
      }));
      break;
    }
    case "Dokument": {
      const ids = idsIn(filter, "id");
      const expand = url.searchParams.get("$expand") ?? "";
      value = (
        ids.length > 0
          ? dokumentRows.filter((row) => ids.includes(Number(row.id)))
          : changedSince(dokumentRows, url)
      ).map((row) => ({
        ...row,
        Dokumenttype: dokumenttyper.get(row.typeid),
        ...(expand.split(",").includes("Fil")
          ? { Fil: filRows.filter((fil) => fil.dokumentid === row.id) }
          : {}),
      }));
      break;
    }
    case "Fil":
      value = changedSince(filRows, url);
      break;
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
    `TRUNCATE tracked_sag, sag, periode, aktoer, sag_aktoer, emneord,
       emneord_sag, sagstrin, afstemning, stemme, dokument, sag_dokument,
       fil, fil_blob`,
  );
  serverPageSize = Infinity;
  fetchMock = mockFetch();
  fetchMock.mockImplementation(async (url) => odaResponse(String(url)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const restore of restores.splice(0).reverse()) restore();
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

function totals(result: { counts: BillsResult["counts"] }) {
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

// Children step: L 211 and L 154 have recorded children; the other tracked
// bills have none in the fixtures.

const childTables = [
  "sagstrin",
  "afstemning",
  "stemme",
  "sag_dokument",
  "dokument",
  "fil",
  "aktoer",
];

/** Every stored child row with its `xmin`, which changes on every write. */
async function childSnapshot(): Promise<string[]> {
  const rows: string[] = [];
  for (const table of childTables)
    for (const row of await database.sql.query(
      `SELECT id, xmin::text AS xmin FROM ${table} ORDER BY id`,
    ))
      rows.push(`${table}:${row.id}:${row.xmin}`);
  return rows;
}

function childTotals(result: ChildrenResult) {
  return Object.fromEntries(
    Object.entries(result.counts).map(([entity, counts]) => [
      entity,
      { inserted: counts.inserted, updated: counts.updated },
    ]),
  );
}

/** The ODA requests made since the mock was last cleared, as `Entity?filter`. */
function queries(): string[] {
  return requestedUrls(fetchMock).map((text) => {
    const url = new URL(text);
    return `${entityOf(url)}?${filterOf(url)}`;
  });
}

/** Requests that name single bills, votes or documents. */
function perBillQueries(): string[] {
  return queries().filter((query) =>
    /(?<![\w/])(sagid|Sagstrin\/sagid|afstemningid) eq |^(Dokument|Sag)\?.*(?<![\w/])id eq /.test(
      query,
    ),
  );
}

// The children step's clock. Fixture rows are older than this.
const childrenStart = Date.parse("2026-11-22T12:00:00.000Z");
const atStart = () => childrenStart;
/** An ODA timestamp at the children step's start (local time). */
const odaNow = formatOdaTimestamp(new Date(childrenStart));

function doneWatermarks(result: ChildrenResult): ChildrenWatermarks {
  if (!result.done) throw new Error("not done");
  return result.watermarks;
}

describe("ingestChildren", () => {
  beforeEach(async () => {
    await runSessions();
    const bills = await ingestBills(database.sql);
    expect(bills.done).toBe(true);
    fetchMock.mockClear();
  });

  it("gives newly tracked bills all their children on a first run", async () => {
    // Changed in test code: two Stemme rows reference Aktør 204 (not
    // stored: it is L 31's ministry) and Aktør 206 (stored by step 2).
    changeRow(stemmePages[1].rows, 2289692, (row) => ({
      ...row,
      aktørid: 204,
    }));
    changeRow(stemmePages[1].rows, 2289693, (row) => ({
      ...row,
      aktørid: 206,
    }));

    const result = await ingestChildren(database.sql, { now: atStart });
    expect(result.done).toBe(true);

    expect(await ids("sagstrin")).toEqual(
      sagstrinRows.map((row) => Number(row.id)).sort((a, b) => a - b),
    );
    expect(await ids("afstemning")).toEqual([10204]);
    expect(await ids("stemme")).toEqual([
      2289592, 2289593, 2289594, 2289692, 2289693,
    ]);
    expect(await ids("sag_dokument")).toEqual(
      sagDokumentRows.map((row) => Number(row.id)).sort((a, b) => a - b),
    );
    expect(await ids("dokument")).toEqual(
      dokumentRows.map((row) => Number(row.id)).sort((a, b) => a - b),
    );
    expect(await ids("fil")).toEqual(
      filRows.map((row) => Number(row.id)).sort((a, b) => a - b),
    );
    expect(await ids("aktoer")).toContain(204);
    expect(result.counts).toMatchObject({
      sagstrin: { fetched: 26, inserted: 26 },
      afstemning: { fetched: 1, inserted: 1 },
      stemme: { fetched: 5, inserted: 5 },
      sag_dokument: { fetched: 6, inserted: 6 },
      dokument: { fetched: 6, inserted: 6 },
      fil: { fetched: 8, inserted: 8 },
      aktoer: { inserted: 1, updated: 0 },
    });

    // Lookup names are stored next to their ids.
    const [stage] = await database.sql.query(
      "SELECT type, raw FROM sagstrin WHERE id = 265468",
    );
    expect(stage.type).toBe("Fremsættelse");
    expect(stage.raw).not.toHaveProperty("Sagstrinstype");
    const [link] = await database.sql.query(
      "SELECT rolle FROM sag_dokument WHERE id = 1472879",
    );
    expect(link.rolle).toBe("På sagstrin");
    const [dokument] = await database.sql.query(
      "SELECT type, raw FROM dokument WHERE id = 1160076",
    );
    expect(dokument.type).toBe("Forslagstekst");
    expect(dokument.raw).not.toHaveProperty("Fil");
    const [stemme] = await database.sql.query(
      "SELECT type FROM stemme WHERE id = 2289592",
    );
    expect(stemme.type).toBe("Fravær");

    // Requests cover a unit's bills at once (five bills per unit); the
    // untracked L 31 is never asked for; stored Aktør rows are not fetched.
    const all = queries();
    expect(all).toContain(
      "Sagstrin?(sagid eq 69354 or sagid eq 101039 or sagid eq 101043 or sagid eq 101403 or sagid eq 101687)",
    );
    expect(all).toContain("Sagstrin?(sagid eq 101688)");
    expect(all).toContain(
      "Afstemning?(Sagstrin/sagid eq 69354 or Sagstrin/sagid eq 101039 or Sagstrin/sagid eq 101043 or Sagstrin/sagid eq 101403 or Sagstrin/sagid eq 101687)",
    );
    expect(all.filter((query) => query.startsWith("Stemme?"))).toEqual([
      "Stemme?(afstemningid eq 10204)",
      "Stemme?afstemningid eq 10204",
    ]);
    // Aktør 206 is stored; the fixtures serve only 204 of the others.
    expect(all.filter((query) => query.startsWith("Aktør?"))).toEqual([
      "Aktør?id eq 102 or id eq 204 or id eq 217 or id eq 18713",
    ]);
    expect(all.join("\n")).not.toContain("99215");
    // No changed-since queries on a first run.
    expect(all.some((query) => query.includes("opdateringsdato gt"))).toBe(
      false,
    );

    const watermarks = doneWatermarks(result);
    for (const entity of [
      "sagstrin",
      "afstemning",
      "sag_dokument",
      "dokument",
      "fil",
    ] as const)
      expect(watermarks[entity].getTime()).toBe(childrenStart);
    expect(
      Math.abs(watermarks.tracked_sag.getTime() - Date.now()),
    ).toBeLessThan(60_000);
  });

  it("makes no per-bill child queries and writes nothing on a second run with unchanged data", async () => {
    const first = await ingestChildren(database.sql, { now: atStart });
    const before = await childSnapshot();
    fetchMock.mockClear();

    const second = await ingestChildren(database.sql, {
      since: doneWatermarks(first),
      now: atStart,
    });
    expect(second.done).toBe(true);
    for (const counts of Object.values(childTotals(second)))
      expect(counts).toEqual({ inserted: 0, updated: 0 });
    expect(await childSnapshot()).toEqual(before);
    expect(perBillQueries()).toEqual([]);
    // One page per changed-since query, starting an hour before the
    // watermark (local time), in scope where ODA can filter by bill.
    expect(queries()).toEqual([
      "Sagstrin?opdateringsdato gt datetime'2026-11-22T12:00:00' and Sag/typeid eq 3 and (Sag/periodeid eq 163 or Sag/periodeid eq 165 or Sag/periodeid eq 167 or Sag/periodeid eq 168) and id gt 0",
      "Afstemning?opdateringsdato gt datetime'2026-11-22T12:00:00' and id gt 0",
      "SagDokument?opdateringsdato gt datetime'2026-11-22T12:00:00' and Sag/typeid eq 3 and (Sag/periodeid eq 163 or Sag/periodeid eq 165 or Sag/periodeid eq 167 or Sag/periodeid eq 168) and id gt 0",
      "Dokument?opdateringsdato gt datetime'2026-11-22T12:00:00' and id gt 0",
      "Fil?opdateringsdato gt datetime'2026-11-22T12:00:00' and id gt 0",
    ]);
    expect(doneWatermarks(second)).toMatchObject({
      sagstrin: new Date(childrenStart),
      fil: new Date(childrenStart),
    });
  });

  it("writes nothing for unchanged rows returned by the changed-since queries", async () => {
    const first = await ingestChildren(database.sql, { now: atStart });
    const before = await childSnapshot();
    fetchMock.mockClear();

    // An old watermark: every fixture row comes back from ODA.
    const old = new Date("2025-01-01T00:00:00.000Z");
    const second = await ingestChildren(database.sql, {
      since: {
        tracked_sag: doneWatermarks(first).tracked_sag,
        sagstrin: old,
        afstemning: old,
        sag_dokument: old,
        dokument: old,
        fil: old,
      },
      now: atStart,
    });
    expect(second.counts).toMatchObject({
      sagstrin: { fetched: 26, inserted: 0, updated: 0, unchanged: 26 },
      afstemning: { fetched: 1, inserted: 0, updated: 0, unchanged: 1 },
      sag_dokument: { fetched: 6, inserted: 0, updated: 0, unchanged: 6 },
      dokument: { fetched: 6, inserted: 0, updated: 0, unchanged: 6 },
      fil: { fetched: 8, inserted: 0, updated: 0, unchanged: 8 },
      stemme: { fetched: 0 },
    });
    expect(await childSnapshot()).toEqual(before);
    // The vote did not change, so its Stemme rows were not fetched again.
    expect(perBillQueries()).toEqual([]);
    // The new watermark is the highest opdateringsdato fetched.
    const fil = Math.max(
      ...filRows.map(
        (row) =>
          tryParseOdaTimestamp(String(row.opdateringsdato))?.getTime() ?? 0,
      ),
    );
    expect(doneWatermarks(second).fil.getTime()).toBe(fil);
  });

  it("updates a changed Sagstrin", async () => {
    const first = await ingestChildren(database.sql, { now: atStart });
    // Changed in test code: ODA changes a stage of L 211.
    changeRow(sagstrinRows, 265468, (row) => ({
      ...row,
      titel: "Fremsættelse (changed)",
      opdateringsdato: odaNow,
    }));
    fetchMock.mockClear();

    const second = await ingestChildren(database.sql, {
      since: doneWatermarks(first),
      now: () => childrenStart + 60_000,
    });
    expect(second.counts.sagstrin).toEqual({
      fetched: 1,
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    for (const entity of ["afstemning", "stemme", "sag_dokument", "fil"])
      expect(childTotals(second)[entity]).toEqual({ inserted: 0, updated: 0 });
    const [row] = await database.sql.query(
      "SELECT titel FROM sagstrin WHERE id = 265468",
    );
    expect(row.titel).toBe("Fremsættelse (changed)");
    expect(perBillQueries()).toEqual([]);
    expect(doneWatermarks(second).sagstrin.getTime()).toBe(childrenStart);
  });

  it("fetches all Stemme rows of a changed vote again", async () => {
    const first = await ingestChildren(database.sql, { now: atStart });
    // Changed in test code: ODA updates vote 10204.
    changeRow(afstemningRows, 10204, (row) => ({
      ...row,
      opdateringsdato: odaNow,
    }));
    fetchMock.mockClear();

    const second = await ingestChildren(database.sql, {
      since: doneWatermarks(first),
      now: atStart,
    });
    expect(second.counts.afstemning).toMatchObject({ updated: 1 });
    expect(second.counts.stemme).toEqual({
      fetched: 5,
      inserted: 0,
      updated: 0,
      unchanged: 5,
    });
    expect(perBillQueries()).toEqual([
      "Stemme?(afstemningid eq 10204)",
      "Stemme?afstemningid eq 10204",
    ]);
  });

  it("ignores children of untracked bills", async () => {
    const first = await ingestChildren(database.sql, { now: atStart });
    const before = await childSnapshot();
    // Added in test code, from recorded rows: children of L 31 (Sag 99215,
    // not tracked) and of a document of no tracked bill, changed now.
    addRow(sagstrinRows, {
      ...sagstrinRows[0],
      id: 900001,
      sagid: 99215,
      opdateringsdato: odaNow,
    });
    addRow(afstemningRows, {
      ...afstemningRows[0],
      id: 900002,
      sagstrinid: 900001,
      opdateringsdato: odaNow,
    });
    addRow(sagDokumentRows, {
      ...sagDokumentRows[0],
      id: 900003,
      sagid: 99215,
      dokumentid: 900004,
      opdateringsdato: odaNow,
    });
    addRow(dokumentRows, {
      ...dokumentRows[0],
      id: 900004,
      opdateringsdato: odaNow,
    });
    addRow(filRows, {
      ...filRows[0],
      id: 900005,
      dokumentid: 900004,
      opdateringsdato: odaNow,
    });
    fetchMock.mockClear();

    const second = await ingestChildren(database.sql, {
      since: doneWatermarks(first),
      now: atStart,
    });
    expect(second.counts).toMatchObject({
      sagstrin: { fetched: 1, inserted: 0, updated: 0, unchanged: 0 },
      afstemning: { fetched: 1, inserted: 0, updated: 0, unchanged: 0 },
      sag_dokument: { fetched: 1, inserted: 0, updated: 0, unchanged: 0 },
      dokument: { fetched: 1, inserted: 0, updated: 0, unchanged: 0 },
      fil: { fetched: 1, inserted: 0, updated: 0, unchanged: 0 },
    });
    expect(await childSnapshot()).toEqual(before);
    expect(perBillQueries()).toEqual([]);
  });

  it("fetches a document that a tracked bill links to again", async () => {
    const first = await ingestChildren(database.sql, { now: atStart });
    // Added in test code, from recorded rows: L 211 links to a document
    // (with one file) that is not stored yet.
    addRow(sagDokumentRows, {
      ...sagDokumentRows[3],
      id: 900003,
      dokumentid: 900004,
      opdateringsdato: odaNow,
    });
    addRow(dokumentRows, { ...dokumentRows[3], id: 900004 });
    addRow(filRows, { ...filRows[3], id: 900005, dokumentid: 900004 });
    fetchMock.mockClear();

    const second = await ingestChildren(database.sql, {
      since: doneWatermarks(first),
      now: atStart,
    });
    expect(childTotals(second)).toMatchObject({
      sag_dokument: { inserted: 1, updated: 0 },
      dokument: { inserted: 1, updated: 0 },
      fil: { inserted: 1, updated: 0 },
    });
    expect(perBillQueries()).toEqual(["Dokument?(id eq 900004)"]);
  });

  it("stops at the deadline with progress that a second call completes", async () => {
    let clock = childrenStart;
    const now = () => clock;
    fetchMock.mockImplementation(async (url) => {
      const response = odaResponse(String(url));
      if (entityOf(new URL(String(url))) === "Sagstrin") clock += 1;
      return response;
    });
    const first = await ingestChildren(database.sql, {
      billsPerUnit: 2,
      deadline: clock + 1,
      now,
    });
    expect(first.done).toBe(false);
    if (first.done) throw new Error("done");
    expect(first.cursor).toMatchObject({ afterSagId: 101039, since: null });
    expect(await ids("sagstrin")).toEqual(
      sagstrinRows
        .filter((row) => row.sagid === 101039)
        .map((row) => Number(row.id)),
    );

    const cursor = JSON.parse(JSON.stringify(first.cursor));
    const second = await ingestChildren(database.sql, {
      cursor,
      billsPerUnit: 2,
    });
    expect(second.done).toBe(true);
    expect(
      first.counts.sagstrin.inserted + second.counts.sagstrin.inserted,
    ).toBe(26);
    expect(await ids("sagstrin")).toHaveLength(26);
    expect(doneWatermarks(second).sagstrin.getTime()).toBe(childrenStart);
  });

  it("writes nothing when the signal stops a unit mid-way", async () => {
    const before = await childSnapshot();
    const controller = new AbortController();
    fetchMock.mockImplementation(async (url) => {
      if (entityOf(new URL(String(url))) === "SagDokument") controller.abort();
      return odaResponse(String(url));
    });
    const first = await ingestChildren(database.sql, {
      signal: controller.signal,
    });
    expect(first.done).toBe(false);
    if (first.done) throw new Error("done");
    expect(first.cursor).toMatchObject({ afterSagId: 0 });
    expect(await childSnapshot()).toEqual(before);

    fetchMock.mockImplementation(async (url) => odaResponse(String(url)));
    const second = await ingestChildren(database.sql, { cursor: first.cursor });
    expect(second.done).toBe(true);
    expect(await ids("sagstrin")).toHaveLength(26);
  });

  it("fails with a fixed message when ODA fails", async () => {
    fetchMock.mockImplementation(async () => statusResponse(400));
    await expect(ingestChildren(database.sql)).rejects.toThrow(
      new IngestError(ingestErrors.oda),
    );
  });
});

// Links step: links and actors that change while the Sag does not.

/** The `sag` watermark of the first bills run (L 152's opdateringsdato). */
const sagWatermark = new Date("2025-09-30T09:10:02.510Z");
const linksStart = Date.parse("2026-11-22T12:00:00.000Z");

async function trackedRow(sagId: number, topic: string) {
  const [row] = await database.sql.query(
    "SELECT matching, matched_rules, xmin::text AS xmin FROM tracked_sag WHERE sag_id = $1 AND topic = $2",
    [sagId, topic],
  );
  return row;
}

describe("ingestLinks", () => {
  beforeEach(async () => {
    await runSessions();
    const bills = await ingestBills(database.sql);
    if (!bills.done) throw new Error("not done");
    expect(bills.watermark).toEqual(sagWatermark);
    fetchMock.mockClear();
  });

  it("re-fetches the overlap and writes nothing when no link changed", async () => {
    const before = await snapshot();
    const result = await ingestLinks(database.sql, {
      initialSince: sagWatermark,
      now: () => linksStart,
    });
    expect(result.done).toBe(true);
    for (const counts of Object.values(totals(result)))
      expect(counts).toEqual({ inserted: 0, updated: 0 });
    expect(await snapshot()).toEqual(before);

    const all = queries();
    expect(all[0]).toBe(
      "SagAktør?opdateringsdato gt datetime'2025-09-30T10:10:02' and Sag/typeid eq 3 and (Sag/periodeid eq 163 or Sag/periodeid eq 165 or Sag/periodeid eq 167 or Sag/periodeid eq 168) and id gt 0",
    );
    expect(all).toContain(
      "Aktør?opdateringsdato gt datetime'2025-09-30T10:10:02' and id gt 0",
    );
    expect(all).toContain(
      "Emneord?opdateringsdato gt datetime'2025-09-30T10:10:02' and id gt 0",
    );
    if (!result.done) throw new Error("not done");
    // L 152's links changed at the watermark; they are the highest fetched.
    expect(result.watermarks.sag_aktoer).toEqual(sagWatermark);
    expect(result.watermarks.emneord_sag).toEqual(sagWatermark);
    // Aktør rows changed in 2026; capped at the step's start at most.
    expect(result.watermarks.aktoer.getTime()).toBeLessThanOrEqual(linksStart);
  });

  it("skips an entity without a watermark and starts it at the step's start", async () => {
    const result = await ingestLinks(database.sql, { now: () => linksStart });
    expect(result.done).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    if (!result.done) throw new Error("not done");
    expect(result.watermarks.emneord.getTime()).toBe(linksStart);
  });

  it("stores a bill that a changed SagAktør row makes a candidate, and the children step fetches its children", async () => {
    const children = await ingestChildren(database.sql, { now: atStart });
    const sagBefore = await snapshot();
    // Changed in test code: L 31's ministry (role 6) becomes
    // Forsvarsministeriet (Aktør 11). Its Sag does not change.
    changeRow(sagAktoerRows, 1774359, (row) => ({
      ...row,
      aktørid: 11,
      opdateringsdato: "2026-11-22T10:00:00",
    }));
    fetchMock.mockClear();

    const result = await ingestLinks(database.sql, {
      initialSince: sagWatermark,
      now: () => linksStart,
    });
    expect(result.done).toBe(true);
    expect(await ids("sag")).toContain(99215);
    expect(await trackedRow(99215, "defence")).toMatchObject({
      matching: true,
      matched_rules: [
        {
          kind: "ministry",
          value: "Forsvarsministeriet",
          field: "ministeromraade",
        },
      ],
    });
    expect(result.counts.sag).toMatchObject({ inserted: 1, updated: 0 });
    expect(result.counts.tracked_sag).toMatchObject({ inserted: 1 });
    // Rows stored before (the other bills) were not written.
    const after = await snapshot();
    expect(sagBefore.filter((row) => !after.includes(row))).toEqual([]);
    if (!result.done) throw new Error("not done");
    expect(result.watermarks.sag_aktoer.toISOString()).toBe(
      "2026-11-22T09:00:00.000Z",
    );

    // The children step treats L 31 as newly tracked.
    fetchMock.mockClear();
    const next = await ingestChildren(database.sql, {
      since: doneWatermarks(children),
      now: atStart,
    });
    expect(next.done).toBe(true);
    expect(queries()).toContain("Sagstrin?(sagid eq 99215)");
    expect(perBillQueries()).toEqual([
      "Sagstrin?(sagid eq 99215)",
      "Afstemning?(Sagstrin/sagid eq 99215)",
      "SagDokument?(sagid eq 99215)",
    ]);
  });

  it("re-evaluates a bill whose EmneordSag row changed, up to matching = false", async () => {
    // Changed in test code: L 31 gets the Emneord NATO (34170, recorded on
    // L 188), so it becomes a defence candidate.
    changeRow(emneordSagRows, 865276, (row) => ({
      ...row,
      emneordid: 34170,
      opdateringsdato: "2026-11-22T10:00:00",
    }));
    const first = await ingestLinks(database.sql, {
      initialSince: sagWatermark,
      now: () => linksStart,
    });
    if (!first.done) throw new Error("not done");
    expect(await trackedRow(99215, "defence")).toMatchObject({
      matching: true,
      matched_rules: [{ kind: "emneord", value: "NATO", field: "emneord" }],
    });
    const [sagBefore] = await database.sql.query(
      "SELECT xmin::text AS xmin FROM sag WHERE id = 99215",
    );

    // Changed in test code: ODA removes the Emneord again, later.
    restores.pop()?.();
    changeRow(emneordSagRows, 865276, (row) => ({
      ...row,
      opdateringsdato: "2026-11-22T11:00:00",
    }));
    const second = await ingestLinks(database.sql, {
      since: first.watermarks,
      now: () => linksStart + 60_000,
    });
    expect(second.done).toBe(true);
    expect(await trackedRow(99215, "defence")).toMatchObject({
      matching: false,
      matched_rules: [],
    });
    expect(second.counts.tracked_sag).toMatchObject({ updated: 1 });
    expect(second.counts.emneord_sag).toMatchObject({ updated: 1 });
    expect(second.counts.sag).toMatchObject({ inserted: 0, updated: 0 });
    const [sagAfter] = await database.sql.query(
      "SELECT xmin::text AS xmin FROM sag WHERE id = 99215",
    );
    expect(sagAfter.xmin).toBe(sagBefore.xmin);
  });

  it("updates only stored Aktør rows and re-evaluates the bills of a renamed ministry", async () => {
    const before = await trackedRow(101687, "defence");
    // Changed in test code: ODA renames Forsvarsministeriet (Aktør 11,
    // stored) and changes Skatteministeriet (Aktør 204, not stored).
    changeRow(aktoerRows, 11, (row) => ({
      ...row,
      navn: "Forsvarsministeriet (renamed)",
      opdateringsdato: "2026-11-22T10:00:00",
    }));
    changeRow(aktoerRows, 204, (row) => ({
      ...row,
      opdateringsdato: "2026-11-22T10:00:00",
    }));
    const result = await ingestLinks(database.sql, {
      initialSince: sagWatermark,
      now: () => linksStart,
    });
    expect(result.done).toBe(true);
    expect(result.counts.aktoer).toMatchObject({ inserted: 0, updated: 1 });
    expect(await ids("aktoer")).not.toContain(204);
    const [aktoer] = await database.sql.query(
      "SELECT navn FROM aktoer WHERE id = 11",
    );
    expect(aktoer.navn).toBe("Forsvarsministeriet (renamed)");
    // L 211 and L 188 had Forsvarsministeriet: they still match on
    // keywords, without the ministry rule.
    expect(result.counts.tracked_sag).toMatchObject({ updated: 2 });
    const after = await trackedRow(101687, "defence");
    expect(after.matching).toBe(true);
    expect(after.matched_rules).toEqual(
      (before.matched_rules as { kind: string }[]).filter(
        (rule) => rule.kind !== "ministry",
      ),
    );
    expect(queries()).toContain(
      "Sag?typeid eq 3 and (periodeid eq 163 or periodeid eq 165 or periodeid eq 167 or periodeid eq 168) and (id eq 101403 or id eq 101687)",
    );
  });

  it("updates only stored Emneord rows and re-evaluates the bills of a changed Emneord", async () => {
    // Changed in test code: ODA changes NATO (34170, stored, linked to
    // L 188) and an Emneord of L 31 (34063, not stored).
    changeEmneord(34170, (row) => ({
      ...row,
      emneord: "NATO (changed)",
      opdateringsdato: "2026-11-22T10:00:00",
    }));
    changeEmneord(34063, (row) => ({
      ...row,
      opdateringsdato: "2026-11-22T10:00:00",
    }));
    const result = await ingestLinks(database.sql, {
      initialSince: sagWatermark,
      now: () => linksStart,
    });
    expect(result.done).toBe(true);
    expect(result.counts.emneord).toMatchObject({ inserted: 0, updated: 1 });
    expect(await ids("emneord")).not.toContain(34063);
    const after = await trackedRow(101403, "defence");
    expect(after.matching).toBe(true);
    expect(after.matched_rules).not.toContainEqual({
      kind: "emneord",
      value: "NATO",
      field: "emneord",
    });
  });

  it("ignores links of bills out of scope", async () => {
    const before = await snapshot();
    // Added in test code, from a recorded row: a ministry link of a case
    // that is not a Lovforslag in scope (ODA would not return it; this
    // checks that the step does not rely on that).
    addRow(sagAktoerRows, {
      ...sagAktoerRows[0],
      id: 900006,
      sagid: 900007,
      aktørid: 11,
      opdateringsdato: "2026-11-22T10:00:00",
    });
    const result = await ingestLinks(database.sql, {
      initialSince: sagWatermark,
      now: () => linksStart,
    });
    expect(result.done).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(queries()).toContain(
      // With L 152 (101043), whose links changed at the watermark.
      "Sag?typeid eq 3 and (periodeid eq 163 or periodeid eq 165 or periodeid eq 167 or periodeid eq 168) and (id eq 101043 or id eq 900007)",
    );
    expect(await ids("sag")).not.toContain(900007);
  });

  it("stops at the deadline with progress that a second call completes", async () => {
    let clock = linksStart;
    fetchMock.mockImplementation(async (url) => {
      const response = odaResponse(String(url));
      if (entityOf(new URL(String(url))) === "SagAktør") clock += 1;
      return response;
    });
    const first = await ingestLinks(database.sql, {
      initialSince: sagWatermark,
      deadline: clock + 1,
      now: () => clock,
    });
    expect(first.done).toBe(false);
    if (first.done) throw new Error("done");
    expect(first.cursor).toMatchObject({ entityIndex: 0 });
    const cursor = JSON.parse(JSON.stringify(first.cursor));
    const second = await ingestLinks(database.sql, { cursor });
    expect(second.done).toBe(true);
  });

  it("fails with a fixed message when ODA fails", async () => {
    fetchMock.mockImplementation(async () => statusResponse(500));
    await expect(
      ingestLinks(database.sql, {
        initialSince: sagWatermark,
        now: () => linksStart,
      }),
    ).rejects.toThrow(new IngestError(ingestErrors.oda));
  }, 60_000);
});
