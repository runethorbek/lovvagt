/**
 * Ingest repository (spec 002, deliverables 1 and 4) on the SQL test
 * harness: inserts, updates on changed records, no write on unchanged
 * records, `tracked_sag` evaluations and watermarks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  readWatermark,
  sessionIdsFrom,
  storedSagIds,
  upsertAktoer,
  upsertEmneord,
  upsertEmneordSag,
  upsertPeriode,
  upsertSag,
  upsertSagAktoer,
  upsertTrackedSag,
  writeWatermark,
  type TrackedSagRow,
} from "@/lib/ingest/repository";
import { odaParsers, type Sag } from "@/lib/oda";
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
    "TRUNCATE tracked_sag, sag, periode, aktoer, sag_aktoer, emneord, emneord_sag, ingest_run",
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
    });
    expect(await upsertEmneord(database.sql, emneord)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
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
    });
  });

  it("stores EmneordSag with raw without the expanded Emneord", async () => {
    const emneordSag = rows("emneordsag-101687", odaParsers.EmneordSag);
    expect(emneordSag[0].raw).toHaveProperty("Emneord");
    expect(await upsertEmneordSag(database.sql, emneordSag)).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
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
    });
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
