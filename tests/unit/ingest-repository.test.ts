/**
 * Ingest repository (spec 002, deliverables 1 and 4) on the SQL test
 * harness: inserts, updates on changed records, no write on unchanged
 * records (for bills, links and every child table), `tracked_sag`
 * evaluations, the lookups the steps use, and watermarks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  databaseNow,
  readWatermark,
  readWatermarks,
  recordCompletedRun,
  sagIdsTrackedSince,
  sagIdsWithEmneord,
  sagIdsWithMinistry,
  sessionIdsFrom,
  storedIds,
  storedOpdateringsdato,
  storedSagIds,
  upsertAfstemning,
  upsertAktoer,
  upsertDokument,
  upsertEmneord,
  upsertEmneordSag,
  upsertFil,
  upsertPeriode,
  upsertSag,
  upsertSagAktoer,
  upsertSagDokument,
  upsertSagstrin,
  upsertStemme,
  upsertTrackedSag,
  writeWatermark,
  type TrackedSagRow,
  type UpsertCounts,
} from "@/lib/ingest/repository";
import { odaParsers, type Sag } from "@/lib/oda";
import type { SqlExecutor } from "@/lib/db";
import { odaFixture } from "@/tests/support/oda";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "@/tests/support/pglite";

let database: TestDatabase;

beforeAll(async () => {
  database = await createMigratedTestDatabase();
}, 30_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.pg.exec(
    `TRUNCATE tracked_sag, sag, periode, aktoer, sag_aktoer, emneord,
       emneord_sag, ingest_run, sagstrin, afstemning, stemme, dokument,
       sag_dokument, fil, fil_blob`,
  );
});

function rows<T>(name: string, parse: (row: unknown) => T | undefined): T[] {
  return odaFixture(name).value.map((row) => {
    const parsed = parse(row);
    if (parsed === undefined) throw new Error(`invalid row in ${name}`);
    return parsed;
  });
}

const l211 = () => rows("sag-101687", odaParsers.Sag)[0];

/** `xmin` changes whenever Postgres writes a new version of a row. */
async function versions(table: string): Promise<string[]> {
  const result = await database.sql.query(
    `SELECT id, xmin::text AS xmin FROM ${table} ORDER BY id`,
  );
  return result.map((row) => `${row.id}:${row.xmin}`);
}

describe("upsertSag", () => {
  it("inserts a new bill with its typed columns and raw record", async () => {
    const sag = l211();
    expect(await upsertSag(database.sql, [sag])).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      writtenIds: [101687],
    });
    const [row] = await database.sql.query(
      "SELECT nummer, periodeid, opdateringsdato, raw FROM sag WHERE id = 101687",
    );
    expect(row.nummer).toBe("L 211");
    expect(row.periodeid).toBe(163);
    expect((row.opdateringsdato as Date).toISOString()).toBe(
      "2025-07-25T10:35:04.057Z",
    );
    expect(row.raw).toEqual(sag.raw);
  });

  it("writes nothing when the record is unchanged", async () => {
    await upsertSag(database.sql, [l211()]);
    const before = await versions("sag");
    expect(await upsertSag(database.sql, [l211()])).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      writtenIds: [],
    });
    expect(await versions("sag")).toEqual(before);
  });

  it("updates on a changed opdateringsdato", async () => {
    await upsertSag(database.sql, [l211()]);
    const before = await versions("sag");
    const changed: Sag = {
      ...l211(),
      opdateringsdato: new Date("2026-01-05T09:00:00.000Z"),
    };
    expect(await upsertSag(database.sql, [changed])).toMatchObject({
      inserted: 0,
      updated: 1,
      unchanged: 0,
      writtenIds: [101687],
    });
    expect(await versions("sag")).not.toEqual(before);
    const [row] = await database.sql.query(
      "SELECT opdateringsdato FROM sag WHERE id = 101687",
    );
    expect((row.opdateringsdato as Date).toISOString()).toBe(
      "2026-01-05T09:00:00.000Z",
    );
  });

  it("updates on a changed raw record alone", async () => {
    await upsertSag(database.sql, [l211()]);
    const sag = l211();
    const changed: Sag = { ...sag, raw: { ...sag.raw, extra: "new field" } };
    expect(await upsertSag(database.sql, [changed])).toMatchObject({
      updated: 1,
    });
    const [row] = await database.sql.query(
      "SELECT raw ->> 'extra' AS extra FROM sag WHERE id = 101687",
    );
    expect(row.extra).toBe("new field");
  });

  it("counts a mixed batch and handles a row given twice", async () => {
    await upsertSag(database.sql, rows("sag-101039", odaParsers.Sag));
    const counts = await upsertSag(database.sql, [
      ...rows("sag-101039", odaParsers.Sag),
      l211(),
      l211(),
    ]);
    expect(counts).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 1,
      writtenIds: [101687],
    });
  });

  it("does nothing for an empty batch", async () => {
    expect(await upsertSag(database.sql, [])).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      writtenIds: [],
    });
  });
});

describe("mirror tables", () => {
  it("stores periode, aktoer and emneord, and skips unchanged rows", async () => {
    const periode = rows("periode-samling", odaParsers.Periode);
    const aktoer = rows("aktoer-referenced", odaParsers.Aktør);
    const emneord = rows("emneord-33142", odaParsers.Emneord);
    expect(await upsertPeriode(database.sql, periode)).toEqual({
      inserted: 4,
      updated: 0,
      unchanged: 0,
    });
    expect(await upsertAktoer(database.sql, aktoer)).toEqual({
      inserted: 4,
      updated: 0,
      unchanged: 0,
      writtenIds: [8, 11, 206, 21041],
    });
    expect(await upsertEmneord(database.sql, emneord)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      writtenIds: [33142],
    });
    const before = [
      ...(await versions("periode")),
      ...(await versions("aktoer")),
      ...(await versions("emneord")),
    ];
    expect(await upsertPeriode(database.sql, periode)).toMatchObject({
      unchanged: 4,
    });
    expect(await upsertAktoer(database.sql, aktoer)).toMatchObject({
      unchanged: 4,
    });
    expect(await upsertEmneord(database.sql, emneord)).toMatchObject({
      unchanged: 1,
    });
    expect([
      ...(await versions("periode")),
      ...(await versions("aktoer")),
      ...(await versions("emneord")),
    ]).toEqual(before);
  });

  it("stores SagAktør with its role name, and raw without the expansion", async () => {
    const [rolle] = rows("sagaktoerrolle", odaParsers.SagAktørRolle).filter(
      (row) => row.id === 6,
    );
    const sagAktoer = rows("sagaktoer-101687", odaParsers.SagAktør).map(
      (row) => ({
        ...row,
        rolle: row.rolleid === 6 ? rolle.rolle : null,
        raw: {
          ...row.raw,
          ...(row.rolleid === 6 ? { SagAktørRolle: rolle.raw } : {}),
        },
      }),
    );
    expect(await upsertSagAktoer(database.sql, sagAktoer)).toEqual({
      inserted: 4,
      updated: 0,
      unchanged: 0,
      writtenIds: [1822261, 1822262, 1822263, 1822264],
    });
    const [row] = await database.sql.query(
      "SELECT rolle, raw FROM sag_aktoer WHERE rolleid = 6",
    );
    expect(row.rolle).toBe("Ministerområde");
    expect(row.raw).not.toHaveProperty("SagAktørRolle");
    expect(row.raw).toHaveProperty("aktørid", 11);

    // A changed role name is an update even though raw is the same.
    const renamed = sagAktoer.map((entry) =>
      entry.rolleid === 6 ? { ...entry, rolle: "Renamed" } : entry,
    );
    expect(await upsertSagAktoer(database.sql, renamed)).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 3,
      writtenIds: [1822263],
    });
  });

  it("stores EmneordSag with raw without the expanded Emneord", async () => {
    const emneordSag = rows("emneordsag-101687", odaParsers.EmneordSag);
    expect(emneordSag[0].raw).toHaveProperty("Emneord");
    expect(await upsertEmneordSag(database.sql, emneordSag)).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
      writtenIds: [891608, 891609],
    });
    const stored = await database.sql.query("SELECT raw FROM emneord_sag");
    for (const row of stored) expect(row.raw).not.toHaveProperty("Emneord");

    // A change to the linked Emneord alone does not change the link.
    const relinked = emneordSag.map((row) => ({
      ...row,
      raw: { ...row.raw, Emneord: { changed: true } },
    }));
    expect(await upsertEmneordSag(database.sql, relinked)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
      writtenIds: [],
    });
  });
});

/** Lookup rows by id, for composing expanded rows as ODA returns them. */
function lookup(name: string): Map<unknown, Record<string, unknown>> {
  return new Map(odaFixture(name).value.map((row) => [row.id, row]));
}

const sagDokumentRoller = lookup("sagdokumentrolle");
const dokumenttyper = lookup("dokumenttype");
const stemmetyper = lookup("stemmetype");

// Recorded SagDokument rows of L 211 with `Dokument/Fil` expanded.
const l211SagDokument = () => odaFixture("sagdokument-101687").value;

/** Each child table: rows from fixtures, as the children step fetches them. */
const childTables: {
  table: string;
  rows: () => { id: number; opdateringsdato: Date; raw: object }[];
  upsert: (
    sql: SqlExecutor,
    rows: never[],
  ) => Promise<UpsertCounts & { writtenIds?: number[] }>;
  /** A typed column and its expected value for the first row. */
  column: [name: string, value: unknown];
  /** Navigation properties that must not be stored in `raw`. */
  navigation: string[];
}[] = [
  {
    table: "sagstrin",
    // Recorded with `$expand=Sagstrinstype`.
    rows: () => rows("sagstrin-101687", odaParsers.Sagstrin),
    upsert: upsertSagstrin,
    column: ["type", "Fremsættelse"],
    navigation: ["Sagstrinstype"],
  },
  {
    table: "afstemning",
    rows: () => rows("afstemning-101039", odaParsers.Afstemning),
    upsert: upsertAfstemning,
    column: ["moedeid", 14624],
    navigation: [],
  },
  {
    table: "stemme",
    // As fetched with `$expand=Stemmetype`.
    rows: () =>
      ["stemme-10204-p1", "stemme-10204-p2"].flatMap((name) =>
        odaFixture(name).value.map((row) => {
          const parsed = odaParsers.Stemme({
            ...row,
            Stemmetype: stemmetyper.get(row.typeid),
          });
          if (parsed === undefined) throw new Error("invalid Stemme");
          return parsed;
        }),
      ),
    upsert: upsertStemme,
    column: ["aktoerid", 18713],
    navigation: ["Stemmetype"],
  },
  {
    table: "dokument",
    // As fetched with `$expand=Dokumenttype,Fil`.
    rows: () =>
      l211SagDokument().map((row) => {
        const dokument = row.Dokument as Record<string, unknown>;
        const parsed = odaParsers.Dokument({
          ...dokument,
          Dokumenttype: dokumenttyper.get(dokument.typeid),
        });
        if (parsed === undefined) throw new Error("invalid Dokument");
        return parsed;
      }),
    upsert: upsertDokument,
    column: ["type", "Forslagstekst"],
    navigation: ["Dokumenttype", "Fil"],
  },
  {
    table: "sag_dokument",
    // As fetched with `$expand=SagDokumentRolle` (recorded with Dokument/Fil).
    rows: () =>
      l211SagDokument().map((row) => {
        const parsed = odaParsers.SagDokument({
          ...row,
          SagDokumentRolle: sagDokumentRoller.get(row.rolleid),
        });
        if (parsed === undefined) throw new Error("invalid SagDokument");
        return parsed;
      }),
    upsert: upsertSagDokument,
    column: ["rolle", "På sagstrin"],
    navigation: ["SagDokumentRolle", "Dokument"],
  },
  {
    table: "fil",
    rows: () =>
      l211SagDokument().flatMap((row) =>
        ((row.Dokument as { Fil: unknown[] }).Fil ?? []).map((fil) => {
          const parsed = odaParsers.Fil(fil);
          if (parsed === undefined) throw new Error("invalid Fil");
          return parsed;
        }),
      ),
    upsert: upsertFil,
    column: ["format", "PDF"],
    navigation: [],
  },
];

describe.each(childTables)(
  "$table",
  ({ table, rows: childRows, upsert, column, navigation }) => {
    const write = (batch: { id: number }[]) =>
      upsert(database.sql, batch as never[]);

    it("inserts rows with typed columns and raw without expansions", async () => {
      const batch = childRows();
      expect(await write(batch)).toMatchObject({
        inserted: batch.length,
        updated: 0,
        unchanged: 0,
      });
      const [first] = await database.sql.query(
        `SELECT ${column[0]} AS value, raw FROM ${table} WHERE id = $1`,
        [batch[0].id],
      );
      expect(first.value).toBe(column[1]);
      for (const property of navigation)
        expect(first.raw).not.toHaveProperty(property);
      expect(first.raw).toHaveProperty("opdateringsdato");
    });

    it("writes nothing when the rows are unchanged", async () => {
      const batch = childRows();
      await write(batch);
      const before = await versions(table);
      expect(await write(childRows())).toMatchObject({
        inserted: 0,
        updated: 0,
        unchanged: batch.length,
      });
      expect(await versions(table)).toEqual(before);
    });

    it("updates a row with a changed opdateringsdato", async () => {
      const batch = childRows();
      await write(batch);
      // Changed in test code: a later opdateringsdato on the first row.
      const changed = [
        { ...batch[0], opdateringsdato: new Date("2026-11-21T10:00:00.000Z") },
        ...batch.slice(1),
      ];
      expect(await write(changed)).toMatchObject({
        inserted: 0,
        updated: 1,
        unchanged: batch.length - 1,
      });
      const [row] = await database.sql.query(
        `SELECT opdateringsdato FROM ${table} WHERE id = $1`,
        [batch[0].id],
      );
      expect((row.opdateringsdato as Date).toISOString()).toBe(
        "2026-11-21T10:00:00.000Z",
      );
    });
  },
);

describe("lookups for the steps", () => {
  it("finds stored ids and their opdateringsdato", async () => {
    await upsertSagstrin(
      database.sql,
      rows("sagstrin-101687", odaParsers.Sagstrin),
    );
    expect(
      await storedIds(database.sql, "sagstrin", [265468, 1, 265468]),
    ).toEqual(new Set([265468]));
    expect(await storedIds(database.sql, "sagstrin", [])).toEqual(new Set());
    const dates = await storedOpdateringsdato(
      database.sql,
      "sagstrin",
      [265468, 2],
    );
    expect([...dates.keys()]).toEqual([265468]);
    expect(dates.get(265468)?.toISOString()).toBe("2025-04-23T16:03:52.060Z");
  });

  it("finds stored bills by ministry and by Emneord", async () => {
    await upsertSag(database.sql, [l211()]);
    await upsertSagAktoer(
      database.sql,
      rows("sagaktoer-101687", odaParsers.SagAktør),
    );
    await upsertEmneordSag(
      database.sql,
      rows("emneordsag-101687", odaParsers.EmneordSag),
    );
    // Aktør 11 is L 211's ministry (role 6); Aktør 8 has role 14.
    expect(await sagIdsWithMinistry(database.sql, [11], 6)).toEqual([101687]);
    expect(await sagIdsWithMinistry(database.sql, [8], 6)).toEqual([]);
    expect(await sagIdsWithEmneord(database.sql, [33142])).toEqual([101687]);
    expect(await sagIdsWithEmneord(database.sql, [1])).toEqual([]);
  });

  it("finds bills first tracked at or after a time", async () => {
    await upsertSag(database.sql, [
      l211(),
      ...rows("sag-101039", odaParsers.Sag),
    ]);
    await upsertTrackedSag(database.sql, [
      { sagId: 101039, topic: "ai", matching: true, matchedRules: [] },
      { sagId: 101687, topic: "defence", matching: true, matchedRules: [] },
    ]);
    await database.pg.exec(
      `UPDATE tracked_sag SET first_matched_at = '2026-01-01T00:00:00Z'
       WHERE sag_id = 101039`,
    );
    const since = new Date("2026-06-01T00:00:00Z");
    expect(await sagIdsTrackedSince(database.sql, since, 0, 10)).toEqual([
      101687,
    ]);
    expect(await sagIdsTrackedSince(database.sql, null, 0, 10)).toEqual([
      101039, 101687,
    ]);
    expect(await sagIdsTrackedSince(database.sql, null, 101039, 10)).toEqual([
      101687,
    ]);
    expect(await sagIdsTrackedSince(database.sql, null, 0, 1)).toEqual([
      101039,
    ]);
    // A stored bill without any tracked_sag row counts as new.
    await database.pg.exec("DELETE FROM tracked_sag WHERE sag_id = 101039");
    expect(await sagIdsTrackedSince(database.sql, since, 0, 10)).toEqual([
      101039, 101687,
    ]);
  });

  it("reads the database clock", async () => {
    const before = Date.now();
    const now = await databaseNow(database.sql);
    expect(Math.abs(now.getTime() - before)).toBeLessThan(60_000);
  });
});

describe("upsertTrackedSag", () => {
  const defence: TrackedSagRow = {
    sagId: 101687,
    topic: "defence",
    matching: true,
    matchedRules: [
      {
        kind: "ministry",
        value: "Forsvarsministeriet",
        field: "ministeromraade",
      },
    ],
  };

  async function tracked() {
    return database.sql.query(
      `SELECT sag_id, topic, matching, matched_rules, first_matched_at,
              last_evaluated_at, xmin::text AS xmin
       FROM tracked_sag ORDER BY sag_id, topic`,
    );
  }

  beforeEach(async () => {
    await upsertSag(database.sql, [l211()]);
  });

  it("inserts a matching topic", async () => {
    expect(await upsertTrackedSag(database.sql, [defence])).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    const [row] = await tracked();
    expect(row).toMatchObject({
      sag_id: 101687,
      topic: "defence",
      matching: true,
      matched_rules: defence.matchedRules,
    });
  });

  it("does not store a topic that does not match and has no row", async () => {
    expect(
      await upsertTrackedSag(database.sql, [
        { ...defence, topic: "ai", matching: false, matchedRules: [] },
      ]),
    ).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
    expect(await tracked()).toEqual([]);
  });

  it("writes nothing when the evaluation is unchanged", async () => {
    await upsertTrackedSag(database.sql, [defence]);
    const before = await tracked();
    expect(await upsertTrackedSag(database.sql, [defence])).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(await tracked()).toEqual(before);
  });

  it("updates changed rules", async () => {
    await upsertTrackedSag(database.sql, [defence]);
    const matchedRules = [
      ...defence.matchedRules,
      { kind: "keyword", value: "drone", field: "titel" } as const,
    ];
    expect(
      await upsertTrackedSag(database.sql, [{ ...defence, matchedRules }]),
    ).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const [row] = await tracked();
    expect(row.matched_rules).toEqual(matchedRules);
  });

  it("keeps the row with matching = false when the rules stop matching", async () => {
    await upsertTrackedSag(database.sql, [defence]);
    const [before] = await tracked();
    expect(
      await upsertTrackedSag(database.sql, [
        { ...defence, matching: false, matchedRules: [] },
      ]),
    ).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const [after] = await tracked();
    expect(after).toMatchObject({
      sag_id: 101687,
      topic: "defence",
      matching: false,
      matched_rules: [],
    });
    expect(after.first_matched_at).toEqual(before.first_matched_at);
    expect(after.xmin).not.toBe(before.xmin);

    // Matching again flips it back, keeping first_matched_at.
    expect(await upsertTrackedSag(database.sql, [defence])).toMatchObject({
      updated: 1,
    });
    const [again] = await tracked();
    expect(again.matching).toBe(true);
    expect(again.first_matched_at).toEqual(before.first_matched_at);
  });

  it("sets last_evaluated_at for re-evaluated bills even when unchanged", async () => {
    await upsertTrackedSag(database.sql, [defence]);
    await database.pg.exec(
      "UPDATE tracked_sag SET last_evaluated_at = '2025-01-01T00:00:00Z'",
    );
    expect(await upsertTrackedSag(database.sql, [defence], [101687])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    const [row] = await tracked();
    expect((row.last_evaluated_at as Date).getTime()).toBeGreaterThan(
      new Date("2025-01-02T00:00:00Z").getTime(),
    );
  });
});

describe("storedSagIds", () => {
  it("returns the ids that are stored", async () => {
    await upsertSag(database.sql, [l211()]);
    expect(await storedSagIds(database.sql, [101687, 99215])).toEqual(
      new Set([101687]),
    );
    expect(await storedSagIds(database.sql, [])).toEqual(new Set());
  });
});

describe("sessionIdsFrom", () => {
  it("returns stored sessions from a start date, in start order", async () => {
    await upsertPeriode(
      database.sql,
      rows("periode-samling", odaParsers.Periode),
    );
    expect(
      await sessionIdsFrom(database.sql, new Date("2024-09-30T22:00:00Z")),
    ).toEqual([163, 165, 167, 168]);
    expect(
      await sessionIdsFrom(database.sql, new Date("2026-01-01T00:00:00Z")),
    ).toEqual([167, 168]);
  });
});

describe("watermarks", () => {
  async function run(): Promise<number> {
    const [row] = await database.sql.query(
      `INSERT INTO ingest_run (status, lease_expires_at)
       VALUES ('completed', now()) RETURNING id`,
    );
    return Number(row.id);
  }

  it("is undefined before any run stored one", async () => {
    await run();
    expect(await readWatermark(database.sql, "sag")).toBeUndefined();
  });

  it("reads back the watermark of the latest run that stored one", async () => {
    const first = await run();
    await writeWatermark(
      database.sql,
      first,
      "sag",
      new Date("2025-07-25T10:35:04.057Z"),
    );
    expect((await readWatermark(database.sql, "sag"))?.toISOString()).toBe(
      "2025-07-25T10:35:04.057Z",
    );

    const second = await run();
    await run(); // a later run without a watermark
    await writeWatermark(
      database.sql,
      second,
      "sag",
      new Date("2025-09-30T09:10:02.510Z"),
    );
    expect((await readWatermark(database.sql, "sag"))?.toISOString()).toBe(
      "2025-09-30T09:10:02.510Z",
    );
  });

  it("reads the latest watermark of every entity at once", async () => {
    const first = await run();
    await writeWatermark(database.sql, first, "sag", new Date(1000));
    await writeWatermark(database.sql, first, "fil", new Date(2000));
    const second = await run();
    await writeWatermark(database.sql, second, "sag", new Date(3000));
    await database.sql.query(
      `UPDATE ingest_run SET watermarks = watermarks || '{"unknown": "x"}'
       WHERE id = $1`,
      [second],
    );
    expect(await readWatermarks(database.sql)).toEqual({
      sag: new Date(3000),
      fil: new Date(2000),
    });
  });

  it("records a completed run with counts and watermarks", async () => {
    const id = await recordCompletedRun(
      database.sql,
      new Date("2026-11-22T10:00:00.000Z"),
      { bills: { sag: { fetched: 1 } } },
      { sag: new Date(1000), tracked_sag: new Date(2000) },
    );
    const [row] = await database.sql.query(
      "SELECT status, started_at, finished_at, counts, watermarks FROM ingest_run WHERE id = $1",
      [id],
    );
    expect(row).toMatchObject({
      status: "completed",
      counts: { bills: { sag: { fetched: 1 } } },
      watermarks: {
        sag: "1970-01-01T00:00:01.000Z",
        tracked_sag: "1970-01-01T00:00:02.000Z",
      },
    });
    expect((row.started_at as Date).toISOString()).toBe(
      "2026-11-22T10:00:00.000Z",
    );
    expect(row.finished_at).not.toBeNull();
    expect((await readWatermarks(database.sql)).tracked_sag).toEqual(
      new Date(2000),
    );
  });

  it("keeps other keys in watermarks", async () => {
    const id = await run();
    await database.sql.query(
      `UPDATE ingest_run SET watermarks = '{"other": "x"}' WHERE id = $1`,
      [id],
    );
    await writeWatermark(database.sql, id, "sag", new Date(0));
    const [row] = await database.sql.query(
      "SELECT watermarks FROM ingest_run WHERE id = $1",
      [id],
    );
    expect(row.watermarks).toEqual({
      other: "x",
      sag: "1970-01-01T00:00:00.000Z",
    });
  });
});
