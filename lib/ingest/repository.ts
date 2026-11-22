/**
 * Ingest repository: the SQL that stores ODA rows and topic matches (spec
 * 002, deliverables 1 and 4). Written against `SqlExecutor`, so it runs on
 * Neon (`executor()` in `lib/db.ts`) and on PGlite in tests.
 *
 * Every upsert is one set-based statement over a JSON batch
 * (`jsonb_to_recordset`) and writes nothing for a row that is unchanged:
 * `ON CONFLICT ... DO UPDATE ... WHERE (stored columns) IS DISTINCT FROM
 * (new columns)`. Comparing every mapped column covers `opdateringsdato`
 * and `raw` (spec 002) and also names copied from expanded lookups, such as
 * `sag_aktoer.rolle`, which are not in `raw`. Each upsert returns how many
 * rows it inserted, updated and left unchanged; Postgres sets `xmax` to 0 on
 * a freshly inserted row, which tells inserts from updates in `RETURNING`.
 *
 * `raw` is the source record without expanded navigation properties (e.g.
 * `SagAktørRolle`, `Emneord`), so a change to a linked row does not count as
 * a change to the row that links to it.
 */
import type { SqlExecutor } from "@/lib/db";
import type {
  Afstemning,
  Aktoer,
  Dokument,
  Emneord,
  EmneordSag,
  Fil,
  OdaRaw,
  Periode,
  Sag,
  SagAktoer,
  SagDokument,
  Sagstrin,
  Stemme,
} from "@/lib/oda";
import type { MatchedRule, Topic } from "@/lib/ingest/topics";

/** Rows offered to one table, by outcome. */
export type UpsertCounts = {
  inserted: number;
  updated: number;
  unchanged: number;
};

type Column = readonly [name: string, type: string];

const periodeColumns = [
  ["id", "integer"],
  ["type", "text"],
  ["kode", "text"],
  ["titel", "text"],
  ["startdato", "timestamptz"],
  ["slutdato", "timestamptz"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const sagColumns = [
  ["id", "integer"],
  ["typeid", "integer"],
  ["kategoriid", "integer"],
  ["statusid", "integer"],
  ["periodeid", "integer"],
  ["titel", "text"],
  ["titelkort", "text"],
  ["nummer", "text"],
  ["nummerprefix", "text"],
  ["nummernumerisk", "text"],
  ["nummerpostfix", "text"],
  ["resume", "text"],
  ["afstemningskonklusion", "text"],
  ["afgoerelse", "text"],
  ["afgoerelsesdato", "timestamptz"],
  ["afgoerelsesresultatkode", "text"],
  ["lovnummer", "text"],
  ["lovnummerdato", "timestamptz"],
  ["retsinformationsurl", "text"],
  ["fremsatundersagid", "integer"],
  ["deltundersagid", "integer"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const aktoerColumns = [
  ["id", "integer"],
  ["typeid", "integer"],
  ["navn", "text"],
  ["fornavn", "text"],
  ["efternavn", "text"],
  ["gruppenavnkort", "text"],
  ["periodeid", "integer"],
  ["startdato", "timestamptz"],
  ["slutdato", "timestamptz"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const sagAktoerColumns = [
  ["id", "integer"],
  ["sagid", "integer"],
  ["aktoerid", "integer"],
  ["rolleid", "integer"],
  ["rolle", "text"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const emneordColumns = [
  ["id", "integer"],
  ["typeid", "integer"],
  ["emneord", "text"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const emneordSagColumns = [
  ["id", "integer"],
  ["emneordid", "integer"],
  ["sagid", "integer"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const sagstrinColumns = [
  ["id", "integer"],
  ["sagid", "integer"],
  ["typeid", "integer"],
  ["type", "text"],
  ["statusid", "integer"],
  ["titel", "text"],
  ["dato", "timestamptz"],
  ["folketingstidende", "text"],
  ["folketingstidendeurl", "text"],
  ["folketingstidendesidenummer", "text"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const afstemningColumns = [
  ["id", "integer"],
  ["sagstrinid", "integer"],
  ["nummer", "integer"],
  ["typeid", "integer"],
  ["vedtaget", "boolean"],
  ["konklusion", "text"],
  ["kommentar", "text"],
  ["moedeid", "integer"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const stemmeColumns = [
  ["id", "integer"],
  ["afstemningid", "integer"],
  ["aktoerid", "integer"],
  ["typeid", "integer"],
  ["type", "text"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const dokumentColumns = [
  ["id", "integer"],
  ["typeid", "integer"],
  ["type", "text"],
  ["kategoriid", "integer"],
  ["statusid", "integer"],
  ["titel", "text"],
  ["dato", "timestamptz"],
  ["modtagelsesdato", "timestamptz"],
  ["frigivelsesdato", "timestamptz"],
  ["offentlighedskode", "text"],
  ["procedurenummer", "text"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const sagDokumentColumns = [
  ["id", "integer"],
  ["sagid", "integer"],
  ["dokumentid", "integer"],
  ["rolleid", "integer"],
  ["rolle", "text"],
  ["bilagsnummer", "text"],
  ["frigivelsesdato", "timestamptz"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

const filColumns = [
  ["id", "integer"],
  ["dokumentid", "integer"],
  ["titel", "text"],
  ["versionsdato", "timestamptz"],
  ["filurl", "text"],
  ["format", "text"],
  ["variantkode", "text"],
  ["opdateringsdato", "timestamptz"],
  ["raw", "jsonb"],
] as const satisfies readonly Column[];

type ColumnName<C extends readonly Column[]> = C[number][0];
type ColumnRow<C extends readonly Column[]> = Record<ColumnName<C>, unknown>;

const quote = (name: string) => `"${name}"`;

/** Reads the counts row returned by the upsert statements below. */
function readCounts(rows: Record<string, unknown>[]): UpsertCounts {
  const [row] = rows;
  const offered = Number(row?.offered ?? 0);
  const inserted = Number(row?.inserted ?? 0);
  const updated = Number(row?.updated ?? 0);
  return { inserted, updated, unchanged: offered - inserted - updated };
}

/** Keeps the last row per key, so no statement touches a row twice. */
function uniqueBy<T>(rows: readonly T[], key: (row: T) => string | number) {
  return [...new Map(rows.map((row) => [key(row), row])).values()];
}

/**
 * Upserts rows into an ODA mirror table keyed by `id`. Returns the counts and
 * the ids of the rows inserted or updated.
 */
async function upsertMirror<C extends readonly Column[]>(
  sql: SqlExecutor,
  table: string,
  columns: C,
  rows: readonly (ColumnRow<C> & { id: number })[],
): Promise<UpsertCounts & { writtenIds: number[] }> {
  const batch = uniqueBy(rows, (row) => row.id).map((row) =>
    Object.fromEntries(
      columns.map(([name]) => [name, row[name as keyof typeof row]]),
    ),
  );
  if (batch.length === 0)
    return { inserted: 0, updated: 0, unchanged: 0, writtenIds: [] };

  const names = columns.map(([name]) => quote(name));
  const list = names.join(", ");
  const definition = columns
    .map(([name, type]) => `${quote(name)} ${type}`)
    .join(", ");
  const assignments = names.map((name) => `${name} = excluded.${name}`);
  const stored = names.map((name) => `${table}.${name}`).join(", ");
  const incoming = names.map((name) => `excluded.${name}`).join(", ");

  const result = await sql.query(
    `WITH offered AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(${definition})
     ),
     written AS (
       INSERT INTO ${table} (${list})
       SELECT ${list} FROM offered
       ON CONFLICT (id) DO UPDATE SET ${assignments.join(", ")}
       WHERE (${stored}) IS DISTINCT FROM (${incoming})
       RETURNING id, (xmax = 0) AS inserted
     )
     SELECT
       (SELECT count(*) FROM offered)::int AS offered,
       (SELECT count(*) FROM written WHERE inserted)::int AS inserted,
       (SELECT count(*) FROM written WHERE NOT inserted)::int AS updated,
       (SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM written) AS written_ids`,
    [JSON.stringify(batch)],
  );
  const writtenIds = result[0]?.written_ids;
  return {
    ...readCounts(result),
    writtenIds: Array.isArray(writtenIds) ? writtenIds.map(Number) : [],
  };
}

const countsOf = ({ inserted, updated, unchanged }: UpsertCounts) => ({
  inserted,
  updated,
  unchanged,
});

/** The source record without the named (expanded) navigation properties. */
export function withoutNavigation(
  raw: OdaRaw,
  properties: readonly string[],
): OdaRaw {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !properties.includes(key)),
  );
}

/** Upserts sessions. */
export async function upsertPeriode(
  sql: SqlExecutor,
  rows: readonly Periode[],
): Promise<UpsertCounts> {
  return countsOf(await upsertMirror(sql, "periode", periodeColumns, rows));
}

/**
 * Upserts bills. `writtenIds` lists the bills inserted or updated, whose
 * topic evaluation counts as new (see `upsertTrackedSag`).
 */
export async function upsertSag(
  sql: SqlExecutor,
  rows: readonly Sag[],
): Promise<UpsertCounts & { writtenIds: number[] }> {
  return upsertMirror(sql, "sag", sagColumns, rows);
}

/** Upserts Aktør rows. `writtenIds` lists the rows inserted or updated. */
export async function upsertAktoer(
  sql: SqlExecutor,
  rows: readonly Aktoer[],
): Promise<UpsertCounts & { writtenIds: number[] }> {
  return upsertMirror(sql, "aktoer", aktoerColumns, rows);
}

/**
 * Upserts SagAktør rows; `raw` is stored without `SagAktørRolle`/`Aktør`.
 * `writtenIds` lists the rows inserted or updated.
 */
export async function upsertSagAktoer(
  sql: SqlExecutor,
  rows: readonly SagAktoer[],
): Promise<UpsertCounts & { writtenIds: number[] }> {
  return upsertMirror(
    sql,
    "sag_aktoer",
    sagAktoerColumns,
    rows.map((row) => ({
      ...row,
      raw: withoutNavigation(row.raw, ["SagAktørRolle", "Aktør", "Sag"]),
    })),
  );
}

/** Upserts Emneord rows. `writtenIds` lists the rows inserted or updated. */
export async function upsertEmneord(
  sql: SqlExecutor,
  rows: readonly Emneord[],
): Promise<UpsertCounts & { writtenIds: number[] }> {
  return upsertMirror(sql, "emneord", emneordColumns, rows);
}

/**
 * Upserts EmneordSag rows; `raw` is stored without `Emneord`/`Sag`.
 * `writtenIds` lists the rows inserted or updated.
 */
export async function upsertEmneordSag(
  sql: SqlExecutor,
  rows: readonly EmneordSag[],
): Promise<UpsertCounts & { writtenIds: number[] }> {
  return upsertMirror(
    sql,
    "emneord_sag",
    emneordSagColumns,
    rows.map((row) => ({
      ...row,
      raw: withoutNavigation(row.raw, ["Emneord", "Sag"]),
    })),
  );
}

/** Upserts stages; `raw` is stored without `Sagstrinstype`/`Sag`. */
export async function upsertSagstrin(
  sql: SqlExecutor,
  rows: readonly Sagstrin[],
): Promise<UpsertCounts> {
  return countsOf(
    await upsertMirror(
      sql,
      "sagstrin",
      sagstrinColumns,
      rows.map((row) => ({
        ...row,
        raw: withoutNavigation(row.raw, ["Sagstrinstype", "Sag"]),
      })),
    ),
  );
}

/** Upserts votes. */
export async function upsertAfstemning(
  sql: SqlExecutor,
  rows: readonly Afstemning[],
): Promise<UpsertCounts> {
  return countsOf(
    await upsertMirror(
      sql,
      "afstemning",
      afstemningColumns,
      rows.map((row) => ({
        ...row,
        raw: withoutNavigation(row.raw, ["Sagstrin"]),
      })),
    ),
  );
}

/** Upserts individual votes; `raw` is stored without `Stemmetype`. */
export async function upsertStemme(
  sql: SqlExecutor,
  rows: readonly Stemme[],
): Promise<UpsertCounts> {
  return countsOf(
    await upsertMirror(
      sql,
      "stemme",
      stemmeColumns,
      rows.map((row) => ({
        ...row,
        raw: withoutNavigation(row.raw, ["Stemmetype", "Afstemning", "Aktør"]),
      })),
    ),
  );
}

/**
 * Upserts documents; `raw` is stored without `Dokumenttype`/`Fil`. Expanded
 * files are not stored here: pass them to `upsertFil`.
 */
export async function upsertDokument(
  sql: SqlExecutor,
  rows: readonly Dokument[],
): Promise<UpsertCounts> {
  return countsOf(
    await upsertMirror(
      sql,
      "dokument",
      dokumentColumns,
      rows.map((row) => ({
        ...row,
        raw: withoutNavigation(row.raw, ["Dokumenttype", "Fil"]),
      })),
    ),
  );
}

/**
 * Upserts SagDokument rows; `raw` is stored without `SagDokumentRolle`,
 * `Dokument` and `Sag`. An expanded document is not stored here: pass it to
 * `upsertDokument`.
 */
export async function upsertSagDokument(
  sql: SqlExecutor,
  rows: readonly SagDokument[],
): Promise<UpsertCounts> {
  return countsOf(
    await upsertMirror(
      sql,
      "sag_dokument",
      sagDokumentColumns,
      rows.map((row) => ({
        ...row,
        raw: withoutNavigation(row.raw, [
          "SagDokumentRolle",
          "Dokument",
          "Sag",
        ]),
      })),
    ),
  );
}

/** Upserts files (metadata only; the bytes go to Blob in a later step). */
export async function upsertFil(
  sql: SqlExecutor,
  rows: readonly Fil[],
): Promise<UpsertCounts> {
  return countsOf(
    await upsertMirror(
      sql,
      "fil",
      filColumns,
      rows.map((row) => ({
        ...row,
        raw: withoutNavigation(row.raw, ["Dokument"]),
      })),
    ),
  );
}

/** One topic evaluation for a stored bill. */
export type TrackedSagRow = {
  sagId: number;
  topic: Topic;
  matching: boolean;
  matchedRules: readonly MatchedRule[];
};

/**
 * Records topic evaluations in `tracked_sag`:
 *
 * - A matching topic is inserted, or updated if its rules or `matching`
 *   changed.
 * - A topic that does not match is written only if the bill already has a
 *   row for it: the row is kept with `matching = false` and the current
 *   rules. Without a row, nothing is stored.
 * - `last_evaluated_at` is set whenever a row is written, and also for the
 *   bills in `reevaluatedSagIds` (bills whose `sag` row was just inserted or
 *   updated, so they were re-evaluated). A bill that did not change in ODA
 *   is not written, so an immediate second run writes nothing.
 * - `first_matched_at` is set on insert only.
 *
 * Every bill must already be in `sag` (foreign key).
 */
export async function upsertTrackedSag(
  sql: SqlExecutor,
  rows: readonly TrackedSagRow[],
  reevaluatedSagIds: readonly number[] = [],
): Promise<UpsertCounts> {
  const batch = uniqueBy(rows, (row) => `${row.sagId}/${row.topic}`).map(
    (row) => ({
      sag_id: row.sagId,
      topic: row.topic,
      matching: row.matching,
      matched_rules: row.matchedRules,
    }),
  );
  if (batch.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };

  const result = await sql.query(
    `WITH incoming AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS r(sag_id integer, topic text, matching boolean, matched_rules jsonb)
     ),
     offered AS (
       SELECT incoming.* FROM incoming
       WHERE incoming.matching OR EXISTS (
         SELECT 1 FROM tracked_sag t
         WHERE t.sag_id = incoming.sag_id AND t.topic = incoming.topic
       )
     ),
     written AS (
       INSERT INTO tracked_sag (sag_id, topic, matched_rules, matching)
       SELECT sag_id, topic, matched_rules, matching FROM offered
       ON CONFLICT (sag_id, topic) DO UPDATE SET
         matched_rules = excluded.matched_rules,
         matching = excluded.matching,
         last_evaluated_at = now()
       WHERE (tracked_sag.matched_rules, tracked_sag.matching)
           IS DISTINCT FROM (excluded.matched_rules, excluded.matching)
         OR tracked_sag.sag_id IN (
           SELECT jsonb_array_elements_text($2::jsonb)::integer
         )
       RETURNING (xmax = 0) AS inserted
     )
     SELECT
       (SELECT count(*) FROM offered)::int AS offered,
       (SELECT count(*) FROM written WHERE inserted)::int AS inserted,
       (SELECT count(*) FROM written WHERE NOT inserted)::int AS updated`,
    [JSON.stringify(batch), JSON.stringify(reevaluatedSagIds)],
  );
  return readCounts(result);
}

/** ODA mirror tables keyed by `id`. */
export type MirrorTable =
  "sag" | "sagstrin" | "afstemning" | "aktoer" | "dokument" | "emneord";

/** The ids among `ids` that are stored in `table`. */
export async function storedIds(
  sql: SqlExecutor,
  table: MirrorTable,
  ids: readonly number[],
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await sql.query(
    `SELECT id FROM ${table}
     WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::integer)`,
    [JSON.stringify([...new Set(ids)])],
  );
  return new Set(rows.map((row) => Number(row.id)));
}

/** The ids among `sagIds` that are stored in `sag` (tracked bills). */
export async function storedSagIds(
  sql: SqlExecutor,
  sagIds: readonly number[],
): Promise<Set<number>> {
  return storedIds(sql, "sag", sagIds);
}

/** The stored `opdateringsdato` of the given ids in `table`, by id. */
export async function storedOpdateringsdato(
  sql: SqlExecutor,
  table: MirrorTable,
  ids: readonly number[],
): Promise<Map<number, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await sql.query(
    `SELECT id, opdateringsdato FROM ${table}
     WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::integer)`,
    [JSON.stringify([...new Set(ids)])],
  );
  return new Map(
    rows.map((row) => [Number(row.id), new Date(row.opdateringsdato as Date)]),
  );
}

/**
 * Stored bills that were first tracked at or after `since`: bills with no
 * `tracked_sag` row first matched before it (all stored bills when `since`
 * is null). In id order, after `afterId`, at most `limit`.
 */
export async function sagIdsTrackedSince(
  sql: SqlExecutor,
  since: Date | null,
  afterId: number,
  limit: number,
): Promise<number[]> {
  const rows = await sql.query(
    `SELECT s.id FROM sag s
     WHERE s.id > $2
       AND ($1::timestamptz IS NULL OR NOT EXISTS (
         SELECT 1 FROM tracked_sag t
         WHERE t.sag_id = s.id AND t.first_matched_at < $1::timestamptz
       ))
     ORDER BY s.id
     LIMIT $3`,
    [since?.toISOString() ?? null, afterId, limit],
  );
  return rows.map((row) => Number(row.id));
}

/** Stored bills whose ministry (SagAktør role 6) is one of `aktoerIds`. */
export async function sagIdsWithMinistry(
  sql: SqlExecutor,
  aktoerIds: readonly number[],
  ministryRolleId: number,
): Promise<number[]> {
  if (aktoerIds.length === 0) return [];
  const rows = await sql.query(
    `SELECT DISTINCT sa.sagid FROM sag_aktoer sa JOIN sag s ON s.id = sa.sagid
     WHERE sa.rolleid = $2
       AND sa.aktoerid IN (SELECT jsonb_array_elements_text($1::jsonb)::integer)
     ORDER BY sa.sagid`,
    [JSON.stringify(aktoerIds), ministryRolleId],
  );
  return rows.map((row) => Number(row.sagid));
}

/** Stored bills linked to one of `emneordIds` by a stored EmneordSag row. */
export async function sagIdsWithEmneord(
  sql: SqlExecutor,
  emneordIds: readonly number[],
): Promise<number[]> {
  if (emneordIds.length === 0) return [];
  const rows = await sql.query(
    `SELECT DISTINCT es.sagid FROM emneord_sag es JOIN sag s ON s.id = es.sagid
     WHERE es.emneordid IN (SELECT jsonb_array_elements_text($1::jsonb)::integer)
     ORDER BY es.sagid`,
    [JSON.stringify(emneordIds)],
  );
  return rows.map((row) => Number(row.sagid));
}

/** The database clock, so `tracked_sag.first_matched_at` can be compared. */
export async function databaseNow(sql: SqlExecutor): Promise<Date> {
  const [row] = await sql.query("SELECT now() AS now");
  return new Date(row?.now as Date);
}

/**
 * Stored sessions (`type` `samling`) that start at or after `from`, in
 * start order.
 */
export async function sessionIdsFrom(
  sql: SqlExecutor,
  from: Date,
): Promise<number[]> {
  const rows = await sql.query(
    `SELECT id FROM periode
     WHERE type = 'samling' AND startdato >= $1::timestamptz
     ORDER BY startdato, id`,
    [from.toISOString()],
  );
  return rows.map((row) => Number(row.id));
}

/**
 * Entities with a watermark in `ingest_run.watermarks`. Each is the highest
 * ODA `opdateringsdato` handled for that entity, except `tracked_sag`: the
 * database time at which the children step last started (bills first tracked
 * at or after it still need all their children).
 */
export const watermarkEntities = [
  "sag",
  "sag_aktoer",
  "emneord_sag",
  "aktoer",
  "emneord",
  "tracked_sag",
  "sagstrin",
  "afstemning",
  "sag_dokument",
  "dokument",
  "fil",
] as const;

export type WatermarkEntity = (typeof watermarkEntities)[number];

/**
 * The latest stored watermark for an entity: the value in the most recent
 * `ingest_run` row that has one. Steps only produce a watermark when they
 * complete, so any stored value is safe to start from. `undefined` if no run
 * has stored one (the first run fetches everything in scope).
 */
export async function readWatermark(
  sql: SqlExecutor,
  entity: WatermarkEntity,
): Promise<Date | undefined> {
  const rows = await sql.query(
    `SELECT watermarks ->> $1 AS watermark FROM ingest_run
     WHERE watermarks ? $1
     ORDER BY id DESC
     LIMIT 1`,
    [entity],
  );
  const value = rows[0]?.watermark;
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Stores an entity's watermark on an `ingest_run` row, as an ISO string. */
export async function writeWatermark(
  sql: SqlExecutor,
  runId: number,
  entity: WatermarkEntity,
  watermark: Date,
): Promise<void> {
  await sql.query(
    `UPDATE ingest_run
     SET watermarks = watermarks || jsonb_build_object($2::text, $3::text)
     WHERE id = $1`,
    [runId, entity, watermark.toISOString()],
  );
}

/**
 * The latest stored watermark of every entity that has one, like
 * `readWatermark` for each.
 */
export async function readWatermarks(
  sql: SqlExecutor,
): Promise<Partial<Record<WatermarkEntity, Date>>> {
  const rows = await sql.query(
    `SELECT DISTINCT ON (w.key) w.key, w.value
     FROM ingest_run r, jsonb_each_text(r.watermarks) AS w(key, value)
     ORDER BY w.key, r.id DESC`,
  );
  const result: Partial<Record<WatermarkEntity, Date>> = {};
  for (const row of rows) {
    const entity = watermarkEntities.find((name) => name === row.key);
    const date = new Date(String(row.value));
    if (entity !== undefined && !Number.isNaN(date.getTime()))
      result[entity] = date;
  }
  return result;
}

/**
 * Records a completed run with its counts and watermarks, for callers that
 * run the steps without a lease (the local script). Returns the run id.
 */
export async function recordCompletedRun(
  sql: SqlExecutor,
  startedAt: Date,
  counts: Record<string, unknown>,
  watermarks: Partial<Record<WatermarkEntity, Date>>,
): Promise<number> {
  const [row] = await sql.query(
    `INSERT INTO ingest_run
       (status, started_at, finished_at, lease_expires_at, counts, watermarks)
     VALUES ('completed', $1::timestamptz, now(), now(), $2::jsonb, $3::jsonb)
     RETURNING id`,
    [
      startedAt.toISOString(),
      JSON.stringify(counts),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(watermarks).map(([entity, date]) => [
            entity,
            date.toISOString(),
          ]),
        ),
      ),
    ],
  );
  return Number(row?.id);
}
