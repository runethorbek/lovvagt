/**
 * Ingest steps (spec 002, deliverable 4): sessions (1), candidate bills (2),
 * links and actors of bills (2b, `ingestLinks`) and the children of tracked
 * bills (3, `ingestChildren`). Plain async functions over a `SqlExecutor`,
 * independent of how they are triggered, so the route (and later a
 * Workflow) can run them as steps.
 *
 * Each step works in units, checks the caller's `AbortSignal` and deadline
 * before every unit, and returns progress:
 *
 * - `{ done: false, cursor }`: stopped between units. Pass `cursor` back to
 *   continue where it stopped. A unit stopped by the signal while it was
 *   fetching wrote nothing, and is redone from the cursor.
 * - `{ done: true }`: finished. The bills, links and children steps then
 *   return their watermarks for the caller to store (`writeWatermark` in
 *   `repository.ts`). Run them in that order: each relies on the one before.
 *
 * Counts cover the work done by that call only. Errors are `IngestError`s
 * with fixed messages; ODA and driver messages are never passed on.
 */
import type { SqlExecutor } from "@/lib/db";
import {
  type Afstemning,
  type Aktoer,
  type Dokument,
  type Emneord,
  type EmneordSag,
  type Fil,
  type Sag,
  type SagAktoer,
  type SagDokument,
  type Sagstrin,
  type Stemme,
  fetchAfstemning,
  fetchAktoer,
  fetchDokument,
  fetchEmneordSag,
  fetchPeriode,
  fetchSag,
  fetchSagAktoer,
  fetchSagDokument,
  fetchSagstrin,
  fetchStemme,
  formatOdaTimestamp,
  odaPages,
  odaParsers,
} from "@/lib/oda";
import {
  type TrackedSagRow,
  type UpsertCounts,
  databaseNow,
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
} from "@/lib/ingest/repository";
import {
  matchTopics,
  ministeromraadeRolleId,
  topicInput,
} from "@/lib/ingest/topics";

/** Sessions in scope start on or after 2024-10-01, Copenhagen time. */
export const firstSessionStart = new Date("2024-09-30T22:00:00.000Z");

/** Bills (Sagstype `Lovforslag`). */
export const lovforslagTypeId = 3;

/** The next query starts this long before the stored watermark. */
export const watermarkOverlapMs = 60 * 60 * 1000;

/** Bills per unit of the bills step. ODA caps a page at 100. */
export const defaultBillPageSize = 100;

// Ids per request. Keeps each `id eq … or …` filter short.
const idChunkSize = 20;

/** Per-entity counts, as in the route response (spec 002, deliverable 5). */
export type EntityCounts = UpsertCounts & {
  /** Rows fetched from ODA (for `tracked_sag`: topic evaluations offered). */
  fetched: number;
};

export type SessionsEntity = "periode";
export type BillsEntity =
  "sag" | "sag_aktoer" | "aktoer" | "emneord" | "emneord_sag" | "tracked_sag";

export type Counts<E extends string> = Record<E, EntityCounts>;

function emptyCounts<E extends string>(entities: readonly E[]): Counts<E> {
  return Object.fromEntries(
    entities.map((entity) => [
      entity,
      { fetched: 0, inserted: 0, updated: 0, unchanged: 0 },
    ]),
  ) as Counts<E>;
}

function add(
  target: EntityCounts,
  upsert: UpsertCounts,
  fetched = 0,
): EntityCounts {
  target.fetched += fetched;
  target.inserted += upsert.inserted;
  target.updated += upsert.updated;
  target.unchanged += upsert.unchanged;
  return target;
}

/** Fixed error messages for a failed step. */
export const ingestErrors = {
  oda: "ODA request failed",
  database: "database query failed",
} as const;

export type IngestErrorMessage =
  (typeof ingestErrors)[keyof typeof ingestErrors];

/** A failed step. The message is always one of `ingestErrors`. */
export class IngestError extends Error {
  constructor(message: IngestErrorMessage) {
    super(message);
    this.name = "IngestError";
  }
}

// Thrown inside a unit when the caller's signal stopped an ODA request.
class Stopped extends Error {}

export type StepOptions = {
  /** Stops the step: between units, or during an ODA request. */
  signal?: AbortSignal;
  /** Epoch milliseconds. No new unit starts at or after this time. */
  deadline?: number;
  /** The clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

function shouldStop({ signal, deadline, now = Date.now }: StepOptions) {
  return (
    signal?.aborted === true || (deadline !== undefined && now() >= deadline)
  );
}

async function fromOda<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch {
    if (signal?.aborted) throw new Stopped();
    throw new IngestError(ingestErrors.oda);
  }
}

async function fromDatabase<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch {
    throw new IngestError(ingestErrors.database);
  }
}

/** `datetime'…'` literal for an ODA filter, in Copenhagen local time. */
function odaDateTime(instant: Date): string {
  return `datetime'${formatOdaTimestamp(instant)}'`;
}

export type SessionsResult = {
  done: boolean;
  counts: Counts<SessionsEntity>;
};

/**
 * Step 1: upserts every session (`Periode`, `type` `samling`) that starts on
 * or after 2024-10-01. There are only a few, so they are fetched in full
 * every time (one unit, one request); unchanged rows are not written.
 */
export async function ingestSessions(
  sql: SqlExecutor,
  options: StepOptions = {},
): Promise<SessionsResult> {
  const counts = emptyCounts(["periode"] as const);
  if (shouldStop(options)) return { done: false, counts };
  const { signal } = options;
  try {
    const rows = await fromOda(signal, () =>
      fetchPeriode(
        {
          filter: `type eq 'samling' and startdato ge ${odaDateTime(firstSessionStart)}`,
        },
        { signal },
      ),
    );
    add(
      counts.periode,
      await fromDatabase(() => upsertPeriode(sql, rows)),
      rows.length,
    );
  } catch (error) {
    if (error instanceof Stopped) return { done: false, counts };
    throw error;
  }
  return { done: true, counts };
}

/**
 * Where the bills step is. JSON-serialisable, so the caller can store it
 * between calls. Units run session by session, and within a session by
 * ascending Sag id, so `afterId` marks the last bill handled.
 */
export type BillsCursor = {
  /** When the step started (ISO). Caps the new watermark. */
  startedAt: string;
  /** The stored watermark the step started from (ISO), or null. */
  since: string | null;
  /** Sessions in scope when the step started, in start order. */
  sessionIds: number[];
  /** Index into `sessionIds` of the session in progress. */
  sessionIndex: number;
  /** The highest Sag id handled in that session (0: none yet). */
  afterId: number;
  /** The highest Sag `opdateringsdato` fetched so far (ISO), or null. */
  highest: string | null;
};

export type BillsOptions = StepOptions & {
  /** The stored watermark (`readWatermark(sql, "sag")`); omit on a first run. */
  since?: Date;
  /** Progress returned by an earlier call; takes precedence over `since`. */
  cursor?: BillsCursor;
  /** Bills per unit, at most 100. */
  pageSize?: number;
};

export type BillsResult =
  | { done: false; cursor: BillsCursor; counts: Counts<BillsEntity> }
  | {
      done: true;
      counts: Counts<BillsEntity>;
      /** The new `sag` watermark to store, or null if there is none yet. */
      watermark: Date | null;
    };

const billsEntities = [
  "sag",
  "sag_aktoer",
  "aktoer",
  "emneord",
  "emneord_sag",
  "tracked_sag",
] as const;

const maxDate = (a: Date | null, b: Date | null) =>
  a === null ? b : b === null ? a : a > b ? a : b;
const parseIso = (value: string | null) =>
  value === null ? null : new Date(value);

/** Fetches Aktør rows by id, in chunks, in id order. */
async function fetchAktoerById(
  ids: readonly number[],
  signal: AbortSignal | undefined,
): Promise<Aktoer[]> {
  const rows: Aktoer[] = [];
  for (const chunk of chunks(ids, idChunkSize)) {
    const filter = chunk.map((id) => `id eq ${id}`).join(" or ");
    rows.push(...(await fetchAktoer({ filter }, { signal })));
  }
  return rows;
}

/** `(field eq a or field eq b …)` for an ODA filter. */
function anyOf(field: string, ids: readonly number[]): string {
  return `(${ids.map((id) => `${field} eq ${id}`).join(" or ")})`;
}

/** Splits ids (deduplicated, ascending) into chunks for `anyOf` filters. */
function chunks(ids: readonly number[], size: number): number[][] {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const result: number[][] = [];
  for (let start = 0; start < unique.length; start += size)
    result.push(unique.slice(start, start + size));
  return result;
}

/** A bill batch fetched and evaluated, ready to be written. */
type BillsBatch = {
  stored: Sag[];
  aktoer: Aktoer[];
  sagAktoer: SagAktoer[];
  emneord: Emneord[];
  emneordSag: EmneordSag[];
  tracked: TrackedSagRow[];
};

/**
 * Fetches the SagAktør (+ role name, + Aktør) and EmneordSag (+ Emneord)
 * rows of `bills`, evaluates the topic rules and returns what to store: the
 * candidates and the bills already stored (a tracked bill that stops
 * matching keeps its rows). `linkFilter` selects the bills' link rows in
 * ODA; rows of other bills are dropped. Reads the database but writes
 * nothing. Fills the `fetched` counts except `sag`.
 */
async function prepareBills(
  sql: SqlExecutor,
  bills: readonly Sag[],
  linkFilter: string,
  signal: AbortSignal | undefined,
  counts: Counts<BillsEntity>,
): Promise<BillsBatch> {
  const ids = new Set(bills.map((sag) => sag.id));
  const sagAktoer = (
    await fromOda(signal, () =>
      fetchSagAktoer(
        { filter: linkFilter, expand: "SagAktørRolle" },
        { signal },
      ),
    )
  ).filter((row) => ids.has(row.sagid));
  const emneordSag = (
    await fromOda(signal, () =>
      fetchEmneordSag({ filter: linkFilter, expand: "Emneord" }, { signal }),
    )
  ).filter((row) => ids.has(row.sagid));
  counts.sag_aktoer.fetched += sagAktoer.length;
  counts.emneord_sag.fetched += emneordSag.length;
  counts.emneord.fetched += emneordSag.filter(
    (row) => row.emneord !== null,
  ).length;

  // Ministries first: the topic rules need their names.
  const ministries = await fromOda(signal, () =>
    fetchAktoerById(
      sagAktoer
        .filter((row) => row.rolleid === ministeromraadeRolleId)
        .map((row) => row.aktoerid),
      signal,
    ),
  );
  const evaluated = bills.map((sag) => ({
    sag,
    matches: matchTopics(topicInput(sag, sagAktoer, ministries, emneordSag)),
  }));

  const alreadyStored = await fromDatabase(() => storedSagIds(sql, [...ids]));
  const stored = evaluated.filter(
    ({ sag, matches }) =>
      alreadyStored.has(sag.id) || matches.some((match) => match.matching),
  );
  const storedIds = new Set(stored.map(({ sag }) => sag.id));
  const storedSagAktoer = sagAktoer.filter((row) => storedIds.has(row.sagid));
  const storedEmneordSag = emneordSag.filter((row) => storedIds.has(row.sagid));
  const storedEmneord = storedEmneordSag
    .map((row) => row.emneord)
    .filter((row): row is Emneord => row !== null);

  const referenced = new Set(storedSagAktoer.map((row) => row.aktoerid));
  const fetchedIds = new Set(ministries.map((aktoer) => aktoer.id));
  const others = await fromOda(signal, () =>
    fetchAktoerById(
      [...referenced].filter((id) => !fetchedIds.has(id)),
      signal,
    ),
  );
  counts.aktoer.fetched += ministries.length + others.length;

  const tracked = stored.flatMap(({ sag, matches }) =>
    matches.map((match) => ({
      sagId: sag.id,
      topic: match.topic,
      matching: match.matching,
      matchedRules: match.matchedRules,
    })),
  );
  counts.tracked_sag.fetched += tracked.length;

  return {
    stored: stored.map(({ sag }) => sag),
    aktoer: [...ministries, ...others].filter((aktoer) =>
      referenced.has(aktoer.id),
    ),
    sagAktoer: storedSagAktoer,
    emneord: storedEmneord,
    emneordSag: storedEmneordSag,
    tracked,
  };
}

/**
 * Writes a prepared bill batch. A bill counts as re-evaluated (its
 * `tracked_sag.last_evaluated_at` is set) when its `sag` row or one of its
 * link rows was inserted or updated.
 */
async function writeBills(
  sql: SqlExecutor,
  batch: BillsBatch,
  counts: Counts<BillsEntity>,
): Promise<void> {
  await fromDatabase(async () => {
    const sag = await upsertSag(sql, batch.stored);
    add(counts.sag, sag);
    add(counts.aktoer, await upsertAktoer(sql, batch.aktoer));
    const sagAktoer = await upsertSagAktoer(sql, batch.sagAktoer);
    add(counts.sag_aktoer, sagAktoer);
    add(counts.emneord, await upsertEmneord(sql, batch.emneord));
    const emneordSag = await upsertEmneordSag(sql, batch.emneordSag);
    add(counts.emneord_sag, emneordSag);
    const written = new Set([
      ...sagAktoer.writtenIds,
      ...emneordSag.writtenIds,
    ]);
    const reevaluated = new Set(sag.writtenIds);
    for (const row of [...batch.sagAktoer, ...batch.emneordSag])
      if (written.has(row.id)) reevaluated.add(row.sagid);
    add(
      counts.tracked_sag,
      await upsertTrackedSag(sql, batch.tracked, [...reevaluated]),
    );
  });
}

/**
 * One unit of the bills step: the next page of changed bills in a session,
 * prepared and written (`prepareBills`). Fetches everything first and writes
 * after, so a unit stopped while fetching writes nothing. Returns the page's
 * bills (empty when the session is done) and the unit's counts.
 */
async function billsUnit(
  sql: SqlExecutor,
  session: number,
  afterId: number,
  changedAfter: string | null,
  pageSize: number,
  signal: AbortSignal | undefined,
): Promise<{ bills: Sag[]; counts: Counts<BillsEntity> }> {
  const counts = emptyCounts(billsEntities);
  const changed = (field: string) =>
    changedAfter === null ? "" : ` and ${field} gt ${changedAfter}`;

  const bills = await fromOda(signal, async () => {
    const filter = `typeid eq ${lovforslagTypeId} and periodeid eq ${session}${changed("opdateringsdato")} and id gt ${afterId}`;
    for await (const page of odaPages(
      "Sag",
      { filter, orderby: "id", top: pageSize },
      odaParsers.Sag,
      { signal },
    ))
      return page;
    return [];
  });
  counts.sag.fetched = bills.length;
  if (bills.length === 0) return { bills, counts };

  const ids = bills.map((sag) => sag.id);
  // The same scope as the page, through the Sag navigation property, and
  // limited to the page's id range. Rows of other bills are dropped.
  const scope = `sagid ge ${Math.min(...ids)} and sagid le ${Math.max(...ids)} and Sag/typeid eq ${lovforslagTypeId} and Sag/periodeid eq ${session}${changed("Sag/opdateringsdato")}`;
  const batch = await prepareBills(sql, bills, scope, signal, counts);
  await writeBills(sql, batch, counts);
  return { bills, counts };
}

/**
 * Step 2: candidate bills. For every session in scope (stored by step 1),
 * fetches the bills (`Sag`, `typeid eq 3`) changed since the watermark minus
 * one hour (all of them on the first run), evaluates the topic rules and
 * stores the candidates with their SagAktør, Aktør, EmneordSag and Emneord
 * rows and their `tracked_sag` rows. Non-candidates are not stored, unless
 * they are already tracked: then their rows are updated and their topics
 * kept with `matching = false`.
 *
 * A unit is one page of bills (`pageSize`, by ascending id) in one session.
 * A session ends with a unit that finds no more bills.
 * SagAktør and EmneordSag are fetched only for bills whose Sag changed:
 * ODA updates a bill's `opdateringsdato` together with its SagAktør and
 * EmneordSag rows. Changes to a link, an Aktør or an Emneord row alone are
 * picked up by the links step (`ingestLinks`).
 *
 * The new watermark is the highest Sag `opdateringsdato` fetched, but never
 * later than when the step started, so bills that changed while a long
 * backfill ran are fetched again next time. It never goes back.
 */
export async function ingestBills(
  sql: SqlExecutor,
  options: BillsOptions = {},
): Promise<BillsResult> {
  const { signal, pageSize = defaultBillPageSize, now = Date.now } = options;
  const counts = emptyCounts(billsEntities);

  let cursor: BillsCursor = options.cursor ?? {
    startedAt: new Date(now()).toISOString(),
    since: options.since?.toISOString() ?? null,
    sessionIds: await fromDatabase(() =>
      sessionIdsFrom(sql, firstSessionStart),
    ),
    sessionIndex: 0,
    afterId: 0,
    highest: null,
  };

  const since = parseIso(cursor.since);
  const changedAfter =
    since === null
      ? null
      : odaDateTime(new Date(since.getTime() - watermarkOverlapMs));

  while (cursor.sessionIndex < cursor.sessionIds.length) {
    if (shouldStop(options)) return { done: false, cursor, counts };
    let unit: Awaited<ReturnType<typeof billsUnit>>;
    try {
      unit = await billsUnit(
        sql,
        cursor.sessionIds[cursor.sessionIndex],
        cursor.afterId,
        changedAfter,
        pageSize,
        signal,
      );
    } catch (error) {
      if (error instanceof Stopped) return { done: false, cursor, counts };
      throw error;
    }

    const { bills } = unit;
    for (const entity of billsEntities)
      add(counts[entity], unit.counts[entity], unit.counts[entity].fetched);
    const highest = bills.reduce<Date | null>(
      (max, sag) => maxDate(max, sag.opdateringsdato),
      parseIso(cursor.highest),
    );
    cursor = {
      ...cursor,
      highest: highest?.toISOString() ?? null,
      // Only an empty page ends a session: ODA may return fewer rows than
      // `$top` while more exist.
      ...(bills.length === 0
        ? { sessionIndex: cursor.sessionIndex + 1, afterId: 0 }
        : { afterId: Math.max(...bills.map((sag) => sag.id)) }),
    };
  }

  const startedAt = new Date(cursor.startedAt);
  const highest = parseIso(cursor.highest);
  const capped = highest !== null && highest > startedAt ? startedAt : highest;
  return { done: true, counts, watermark: maxDate(since, capped) };
}

/** A watermark as the start of a changed-since query: one hour before it. */
function changedAfterLiteral(since: Date): string {
  return odaDateTime(new Date(since.getTime() - watermarkOverlapMs));
}

/** `Sag/typeid eq 3 and (Sag/periodeid eq a or …)`: bills in scope. */
function billScope(sessionIds: readonly number[], prefix = "Sag/"): string {
  return `${prefix}typeid eq ${lovforslagTypeId} and ${anyOf(`${prefix}periodeid`, sessionIds)}`;
}

/** The highest `opdateringsdato` of `rows`, combined with `highest` (ISO). */
function highestOf(
  rows: readonly { opdateringsdato: Date }[],
  highest: string | undefined,
): string | undefined {
  const max = rows.reduce<Date | null>(
    (value, row) => maxDate(value, row.opdateringsdato),
    parseIso(highest ?? null),
  );
  return max?.toISOString();
}

/**
 * The new watermark of a changed-since query: the highest `opdateringsdato`
 * fetched, never later than the step's start and never earlier than the
 * stored one. Without a stored one, the step's start.
 */
function nextWatermark(
  startedAt: Date,
  since: string | undefined,
  highest: string | undefined,
): Date {
  if (since === undefined) return startedAt;
  const fetched = parseIso(highest ?? null);
  const capped = fetched !== null && fetched > startedAt ? startedAt : fetched;
  return maxDate(new Date(since), capped) ?? startedAt;
}

/**
 * Fetches one page (`$top`, by ascending id) of an entity's rows changed
 * after `changedAfter` that match `scope`, after `afterId`.
 */
async function changedPage<T>(
  entity: string,
  parse: (row: unknown) => T | undefined,
  changedAfter: string,
  scope: string,
  afterId: number,
  pageSize: number,
  signal: AbortSignal | undefined,
  expand?: string,
): Promise<T[]> {
  const filter = `opdateringsdato gt ${changedAfter}${scope === "" ? "" : ` and ${scope}`} and id gt ${afterId}`;
  for await (const page of odaPages(
    entity,
    { filter, orderby: "id", top: pageSize, ...(expand ? { expand } : {}) },
    parse,
    { signal },
  ))
    return page;
  return [];
}

// Step 2b: links and actors of bills.

/** Entities with a changed-since query in the links step, in order. */
export const linksEntities = [
  "sag_aktoer",
  "emneord_sag",
  "aktoer",
  "emneord",
] as const;
export type LinksEntity = (typeof linksEntities)[number];

/**
 * Where the links step is. JSON-serialisable. Units run entity by entity
 * (`linksEntities`), and within an entity by ascending row id.
 */
export type LinksCursor = {
  /** When the step started (ISO). Caps the new watermarks. */
  startedAt: string;
  /** Sessions in scope when the step started. */
  sessionIds: number[];
  /** Where each entity's query starts (ISO); an entity without one is skipped. */
  since: Partial<Record<LinksEntity, string>>;
  /** Index into `linksEntities` of the entity in progress. */
  entityIndex: number;
  /** The highest row id handled for that entity (0: none yet). */
  afterId: number;
  /** The highest `opdateringsdato` fetched per entity (ISO). */
  highest: Partial<Record<LinksEntity, string>>;
};

export type LinksOptions = StepOptions & {
  /** The stored watermarks (`readWatermarks`). */
  since?: Partial<Record<LinksEntity, Date>>;
  /**
   * Where an entity without a stored watermark starts: the `sag` watermark
   * the bills step just returned. That step fetched every link of every
   * bill it fetched after this time, so nothing older is missed.
   */
  initialSince?: Date;
  /** Progress returned by an earlier call; takes precedence. */
  cursor?: LinksCursor;
  /** Rows per unit, at most 100. */
  pageSize?: number;
};

export type LinksResult =
  | { done: false; cursor: LinksCursor; counts: Counts<BillsEntity> }
  | {
      done: true;
      counts: Counts<BillsEntity>;
      /** The new watermarks to store. */
      watermarks: Record<LinksEntity, Date>;
    };

/**
 * Fetches and evaluates the bills `sagIds` that are Lovforslag in the
 * sessions in scope (other ids are ignored), with all their links, like the
 * bills step. Writes nothing; pass the batches to `writeBills`.
 */
async function prepareReevaluation(
  sql: SqlExecutor,
  sagIds: readonly number[],
  sessionIds: readonly number[],
  signal: AbortSignal | undefined,
  counts: Counts<BillsEntity>,
): Promise<BillsBatch[]> {
  const batches: BillsBatch[] = [];
  for (const chunk of chunks(sagIds, idChunkSize)) {
    const bills = await fromOda(signal, () =>
      fetchSag(
        { filter: `${billScope(sessionIds, "")} and ${anyOf("id", chunk)}` },
        { signal },
      ),
    );
    counts.sag.fetched += bills.length;
    if (bills.length === 0) continue;
    const filter = anyOf(
      "sagid",
      bills.map((sag) => sag.id),
    );
    batches.push(await prepareBills(sql, bills, filter, signal, counts));
  }
  return batches;
}

/**
 * One unit of the links step: the next page of changed rows of one entity,
 * and the re-evaluation of the bills they affect:
 *
 * - `sag_aktoer`, `emneord_sag`: rows of Lovforslag in scope. Every bill
 *   with a changed row is re-evaluated, stored or not.
 * - `aktoer`, `emneord`: every row. Only rows already stored are written.
 *   Stored bills linked to a changed ministry (SagAktør role 6) or Emneord
 *   are re-evaluated.
 *
 * Fetches everything first and writes after. Returns the page's rows.
 */
async function linksUnit(
  sql: SqlExecutor,
  entity: LinksEntity,
  cursor: LinksCursor,
  changedAfter: string,
  pageSize: number,
  signal: AbortSignal | undefined,
): Promise<{
  rows: { id: number; opdateringsdato: Date }[];
  counts: Counts<BillsEntity>;
}> {
  const counts = emptyCounts(billsEntities);
  const { afterId, sessionIds } = cursor;
  const page = <T>(name: string, parse: (row: unknown) => T | undefined) =>
    fromOda(signal, () =>
      changedPage(
        name,
        parse,
        changedAfter,
        name === "Aktør" || name === "Emneord" ? "" : billScope(sessionIds),
        afterId,
        pageSize,
        signal,
      ),
    );

  let rows: { id: number; opdateringsdato: Date }[];
  let affected: number[];
  let ownRows: Aktoer[] | Emneord[] = [];
  if (entity === "sag_aktoer" || entity === "emneord_sag") {
    const links: (SagAktoer | EmneordSag)[] =
      entity === "sag_aktoer"
        ? await page("SagAktør", odaParsers.SagAktør)
        : await page("EmneordSag", odaParsers.EmneordSag);
    counts[entity].fetched += links.length;
    rows = links;
    affected = links.map((row) => row.sagid);
  } else {
    const fetched: (Aktoer | Emneord)[] =
      entity === "aktoer"
        ? await page("Aktør", odaParsers.Aktør)
        : await page("Emneord", odaParsers.Emneord);
    counts[entity].fetched += fetched.length;
    rows = fetched;
    const table = entity === "aktoer" ? "aktoer" : "emneord";
    const stored = await fromDatabase(() =>
      storedOpdateringsdato(
        sql,
        table,
        fetched.map((row) => row.id),
      ),
    );
    const kept = fetched.filter((row) => stored.has(row.id));
    const changedIds = kept
      .filter(
        (row) =>
          stored.get(row.id)?.getTime() !== row.opdateringsdato.getTime(),
      )
      .map((row) => row.id);
    affected = await fromDatabase(() =>
      entity === "aktoer"
        ? sagIdsWithMinistry(sql, changedIds, ministeromraadeRolleId)
        : sagIdsWithEmneord(sql, changedIds),
    );
    ownRows = kept as Aktoer[] | Emneord[];
  }

  const batches = await prepareReevaluation(
    sql,
    affected,
    sessionIds,
    signal,
    counts,
  );
  for (const batch of batches) await writeBills(sql, batch, counts);
  // The page's own Aktør or Emneord rows last, so that a database failure
  // before this point finds them changed again. (`writeBills` may already
  // have written a re-fetched ministry row; a failure right after that
  // leaves its bills to be re-evaluated when they or their links change.)
  if (entity === "aktoer")
    add(
      counts.aktoer,
      await fromDatabase(() => upsertAktoer(sql, ownRows as Aktoer[])),
    );
  if (entity === "emneord")
    add(
      counts.emneord,
      await fromDatabase(() => upsertEmneord(sql, ownRows as Emneord[])),
    );
  return { rows, counts };
}

/**
 * Step 2b: links and actors of bills. Step 2 re-evaluates a bill only when
 * its own `Sag` changes; this step closes the gap (human decision
 * 2026-11-22, issue #37). For each entity in `linksEntities` it fetches the
 * rows changed since that entity's watermark minus one hour and
 * re-evaluates the affected bills (see `linksUnit`). A bill that becomes a
 * candidate is stored like any new candidate (the children step then
 * fetches its children); a tracked bill that stops matching keeps its rows
 * with `matching = false`.
 *
 * An entity without a stored watermark starts from `initialSince`; without
 * either it is skipped and its watermark starts at the step's start. Each
 * new watermark is the highest `opdateringsdato` fetched, capped at the
 * step's start and never moved back.
 */
export async function ingestLinks(
  sql: SqlExecutor,
  options: LinksOptions = {},
): Promise<LinksResult> {
  const { signal, pageSize = defaultBillPageSize, now = Date.now } = options;
  const counts = emptyCounts(billsEntities);

  let cursor: LinksCursor = options.cursor ?? {
    startedAt: new Date(now()).toISOString(),
    sessionIds: await fromDatabase(() =>
      sessionIdsFrom(sql, firstSessionStart),
    ),
    since: Object.fromEntries(
      linksEntities.flatMap((entity) => {
        const since = options.since?.[entity] ?? options.initialSince;
        return since === undefined ? [] : [[entity, since.toISOString()]];
      }),
    ),
    entityIndex: 0,
    afterId: 0,
    highest: {},
  };

  while (cursor.entityIndex < linksEntities.length) {
    const entity = linksEntities[cursor.entityIndex];
    const since = cursor.since[entity];
    if (since === undefined || cursor.sessionIds.length === 0) {
      cursor = { ...cursor, entityIndex: cursor.entityIndex + 1, afterId: 0 };
      continue;
    }
    if (shouldStop(options)) return { done: false, cursor, counts };
    let unit: Awaited<ReturnType<typeof linksUnit>>;
    try {
      unit = await linksUnit(
        sql,
        entity,
        cursor,
        changedAfterLiteral(new Date(since)),
        pageSize,
        signal,
      );
    } catch (error) {
      if (error instanceof Stopped) return { done: false, cursor, counts };
      throw error;
    }
    for (const name of billsEntities)
      add(counts[name], unit.counts[name], unit.counts[name].fetched);
    const { rows } = unit;
    cursor = {
      ...cursor,
      highest: {
        ...cursor.highest,
        [entity]: highestOf(rows, cursor.highest[entity]),
      },
      ...(rows.length === 0
        ? { entityIndex: cursor.entityIndex + 1, afterId: 0 }
        : { afterId: Math.max(...rows.map((row) => row.id)) }),
    };
  }

  const startedAt = new Date(cursor.startedAt);
  const watermarks = Object.fromEntries(
    linksEntities.map((entity) => [
      entity,
      nextWatermark(startedAt, cursor.since[entity], cursor.highest[entity]),
    ]),
  ) as Record<LinksEntity, Date>;
  return { done: true, counts, watermarks };
}

// Step 3: children of tracked bills.

export const childrenEntities = [
  "sagstrin",
  "afstemning",
  "stemme",
  "sag_dokument",
  "dokument",
  "fil",
  "aktoer",
] as const;
export type ChildrenEntity = (typeof childrenEntities)[number];

/** Entities with a changed-since query in the children step, in order. */
export const changedChildEntities = [
  "sagstrin",
  "afstemning",
  "sag_dokument",
  "dokument",
  "fil",
] as const;
export type ChangedChildEntity = (typeof changedChildEntities)[number];

/** The children step's watermarks (see `WatermarkEntity`). */
export type ChildrenWatermarks = Record<
  "tracked_sag" | ChangedChildEntity,
  Date
>;

/** Bills per unit of the children step's first phase. */
export const defaultChildrenBillsPerUnit = 5;

// Votes per Stemme request (about 179 rows, two pages, per vote).
const votesPerRequest = 5;

/**
 * Where the children step is. JSON-serialisable. The step runs in two
 * phases: newly tracked bills by ascending Sag id, then the changed-since
 * queries entity by entity (`changedChildEntities`) by ascending row id.
 */
export type ChildrenCursor = {
  /** When the step started (ISO, this machine's clock). Caps the watermarks. */
  startedAt: string;
  /** When the step started by the database clock (ISO): the new `tracked_sag` watermark. */
  trackedFrom: string;
  /** The stored watermarks (ISO), or null on a first run. */
  since: Record<"tracked_sag" | ChangedChildEntity, string> | null;
  /** Sessions in scope when the step started. */
  sessionIds: number[];
  /** First phase: the highest Sag id handled, or null when the phase is done. */
  afterSagId: number | null;
  /** Second phase: index into `changedChildEntities` of the entity in progress. */
  entityIndex: number;
  /** Second phase: the highest row id handled for that entity (0: none yet). */
  afterId: number;
  /** The highest `opdateringsdato` fetched per entity (ISO). */
  highest: Partial<Record<ChangedChildEntity, string>>;
};

export type ChildrenOptions = StepOptions & {
  /**
   * The stored watermarks (`readWatermarks`). If any is missing this is a
   * first run: every stored bill gets all its children, and no
   * changed-since query runs.
   */
  since?: Partial<ChildrenWatermarks>;
  /** Progress returned by an earlier call; takes precedence. */
  cursor?: ChildrenCursor;
  /** Rows per unit of the changed-since queries, at most 100. */
  pageSize?: number;
  /** Bills per unit of the first phase. */
  billsPerUnit?: number;
};

export type ChildrenResult =
  | { done: false; cursor: ChildrenCursor; counts: Counts<ChildrenEntity> }
  | {
      done: true;
      counts: Counts<ChildrenEntity>;
      /** The new watermarks to store. */
      watermarks: ChildrenWatermarks;
    };

/** Fetches documents by id, with their type name and files. */
async function fetchDokumentById(
  ids: readonly number[],
  signal: AbortSignal | undefined,
): Promise<Dokument[]> {
  const rows: Dokument[] = [];
  for (const chunk of chunks(ids, idChunkSize))
    rows.push(
      ...(await fetchDokument(
        { filter: anyOf("id", chunk), expand: "Dokumenttype,Fil" },
        { signal },
      )),
    );
  return rows;
}

/** Fetches every Stemme row of the given votes, with the type name. */
async function fetchStemmeOf(
  afstemningIds: readonly number[],
  signal: AbortSignal | undefined,
): Promise<Stemme[]> {
  const rows: Stemme[] = [];
  for (const chunk of chunks(afstemningIds, votesPerRequest))
    rows.push(
      ...(await fetchStemme(
        { filter: anyOf("afstemningid", chunk), expand: "Stemmetype" },
        { signal },
      )),
    );
  return rows;
}

/** Fetches the Aktør rows referenced by `stemme` that are not stored yet. */
async function fetchMissingAktoer(
  sql: SqlExecutor,
  stemme: readonly Stemme[],
  signal: AbortSignal | undefined,
): Promise<Aktoer[]> {
  const referenced = [...new Set(stemme.map((row) => row.aktoerid))];
  const stored = await fromDatabase(() => storedIds(sql, "aktoer", referenced));
  return fromOda(signal, () =>
    fetchAktoerById(
      referenced.filter((id) => !stored.has(id)),
      signal,
    ),
  );
}

/** Rows to write in one children unit; written in this order. */
type ChildrenBatch = {
  aktoer: Aktoer[];
  fil: Fil[];
  dokument: Dokument[];
  sagDokument: SagDokument[];
  stemme: Stemme[];
  afstemning: Afstemning[];
  sagstrin: Sagstrin[];
};

const emptyBatch = (): ChildrenBatch => ({
  aktoer: [],
  fil: [],
  dokument: [],
  sagDokument: [],
  stemme: [],
  afstemning: [],
  sagstrin: [],
});

/**
 * Writes a children batch. Parents of a fetch go last (documents before
 * their SagDokument, Stemme before their Afstemning), so a unit that fails
 * part-way finds the parent changed again next time.
 */
async function writeChildren(
  sql: SqlExecutor,
  batch: ChildrenBatch,
  counts: Counts<ChildrenEntity>,
): Promise<void> {
  await fromDatabase(async () => {
    add(counts.aktoer, await upsertAktoer(sql, batch.aktoer));
    add(counts.fil, await upsertFil(sql, batch.fil));
    add(counts.dokument, await upsertDokument(sql, batch.dokument));
    add(counts.sag_dokument, await upsertSagDokument(sql, batch.sagDokument));
    add(counts.stemme, await upsertStemme(sql, batch.stemme));
    add(counts.afstemning, await upsertAfstemning(sql, batch.afstemning));
    add(counts.sagstrin, await upsertSagstrin(sql, batch.sagstrin));
  });
}

/**
 * One unit of the first phase: every child of the given newly tracked
 * bills. Requests cover all the unit's bills at once: Sagstrin and
 * SagDokument by `sagid`, Afstemning by `Sagstrin/sagid`, Stemme by
 * `afstemningid`, Dokument (+ Fil) and missing Aktør rows by `id`.
 */
async function newBillsUnit(
  sql: SqlExecutor,
  sagIds: readonly number[],
  signal: AbortSignal | undefined,
): Promise<Counts<ChildrenEntity>> {
  const counts = emptyCounts(childrenEntities);
  const ids = new Set(sagIds);
  const batch = emptyBatch();

  batch.sagstrin = (
    await fromOda(signal, () =>
      fetchSagstrin(
        { filter: anyOf("sagid", sagIds), expand: "Sagstrinstype" },
        { signal },
      ),
    )
  ).filter((row) => ids.has(row.sagid));
  const sagstrinIds = new Set(batch.sagstrin.map((row) => row.id));
  batch.afstemning = (
    await fromOda(signal, () =>
      fetchAfstemning({ filter: anyOf("Sagstrin/sagid", sagIds) }, { signal }),
    )
  ).filter((row) => row.sagstrinid !== null && sagstrinIds.has(row.sagstrinid));
  batch.stemme = await fromOda(signal, () =>
    fetchStemmeOf(
      batch.afstemning.map((row) => row.id),
      signal,
    ),
  );
  batch.aktoer = await fetchMissingAktoer(sql, batch.stemme, signal);

  batch.sagDokument = (
    await fromOda(signal, () =>
      fetchSagDokument(
        { filter: anyOf("sagid", sagIds), expand: "SagDokumentRolle" },
        { signal },
      ),
    )
  ).filter((row) => ids.has(row.sagid));
  batch.dokument = await fromOda(signal, () =>
    fetchDokumentById(
      batch.sagDokument.map((row) => row.dokumentid),
      signal,
    ),
  );
  batch.fil = batch.dokument.flatMap((row) => row.fil ?? []);

  counts.sagstrin.fetched = batch.sagstrin.length;
  counts.afstemning.fetched = batch.afstemning.length;
  counts.stemme.fetched = batch.stemme.length;
  counts.aktoer.fetched = batch.aktoer.length;
  counts.sag_dokument.fetched = batch.sagDokument.length;
  counts.dokument.fetched = batch.dokument.length;
  counts.fil.fetched = batch.fil.length;
  await writeChildren(sql, batch, counts);
  return counts;
}

/**
 * One unit of the second phase: the next page of rows of one entity changed
 * since its watermark, kept only where they belong to a tracked bill:
 *
 * - `sagstrin`, `sag_dokument`: Lovforslag in scope (ODA filter), then
 *   stored bills. A SagDokument whose document is not stored brings the
 *   document and its files.
 * - `afstemning`: every vote (ODA filter on the timestamp only), then votes
 *   on stored stages. A vote that is new or has a new `opdateringsdato`
 *   brings all its Stemme rows and their missing Aktør rows; ODA has no
 *   Stemme watermark here (see `ingestChildren`).
 * - `dokument`, `fil`: every row, then stored documents.
 */
async function changedChildrenUnit(
  sql: SqlExecutor,
  entity: ChangedChildEntity,
  cursor: ChildrenCursor,
  changedAfter: string,
  pageSize: number,
  signal: AbortSignal | undefined,
): Promise<{
  rows: { id: number; opdateringsdato: Date }[];
  counts: Counts<ChildrenEntity>;
}> {
  const counts = emptyCounts(childrenEntities);
  const batch = emptyBatch();
  const page = <T>(
    name: string,
    parse: (row: unknown) => T | undefined,
    scope: string,
    expand?: string,
  ) =>
    fromOda(signal, () =>
      changedPage(
        name,
        parse,
        changedAfter,
        scope,
        cursor.afterId,
        pageSize,
        signal,
        expand,
      ),
    );
  const scope = billScope(cursor.sessionIds);
  const read = fromDatabase;

  let rows: { id: number; opdateringsdato: Date }[];
  switch (entity) {
    case "sagstrin": {
      const fetched = await page(
        "Sagstrin",
        odaParsers.Sagstrin,
        scope,
        "Sagstrinstype",
      );
      rows = fetched;
      const stored = await read(() =>
        storedSagIds(
          sql,
          fetched.map((row) => row.sagid),
        ),
      );
      batch.sagstrin = fetched.filter((row) => stored.has(row.sagid));
      break;
    }
    case "afstemning": {
      const fetched = await page("Afstemning", odaParsers.Afstemning, "");
      rows = fetched;
      const stages = await read(() =>
        storedIds(
          sql,
          "sagstrin",
          fetched.flatMap((row) =>
            row.sagstrinid === null ? [] : [row.sagstrinid],
          ),
        ),
      );
      batch.afstemning = fetched.filter(
        (row) => row.sagstrinid !== null && stages.has(row.sagstrinid),
      );
      const stored = await read(() =>
        storedOpdateringsdato(
          sql,
          "afstemning",
          batch.afstemning.map((row) => row.id),
        ),
      );
      const changedVotes = batch.afstemning.filter(
        (row) =>
          stored.get(row.id)?.getTime() !== row.opdateringsdato.getTime(),
      );
      batch.stemme = await fromOda(signal, () =>
        fetchStemmeOf(
          changedVotes.map((row) => row.id),
          signal,
        ),
      );
      batch.aktoer = await fetchMissingAktoer(sql, batch.stemme, signal);
      counts.stemme.fetched = batch.stemme.length;
      counts.aktoer.fetched = batch.aktoer.length;
      break;
    }
    case "sag_dokument": {
      const fetched = await page(
        "SagDokument",
        odaParsers.SagDokument,
        scope,
        "SagDokumentRolle",
      );
      rows = fetched;
      const stored = await read(() =>
        storedSagIds(
          sql,
          fetched.map((row) => row.sagid),
        ),
      );
      batch.sagDokument = fetched.filter((row) => stored.has(row.sagid));
      const dokumentIds = batch.sagDokument.map((row) => row.dokumentid);
      const storedDokument = await read(() =>
        storedIds(sql, "dokument", dokumentIds),
      );
      batch.dokument = await fromOda(signal, () =>
        fetchDokumentById(
          dokumentIds.filter((id) => !storedDokument.has(id)),
          signal,
        ),
      );
      batch.fil = batch.dokument.flatMap((row) => row.fil ?? []);
      counts.dokument.fetched = batch.dokument.length;
      counts.fil.fetched = batch.fil.length;
      break;
    }
    case "dokument": {
      const fetched = await page(
        "Dokument",
        odaParsers.Dokument,
        "",
        "Dokumenttype",
      );
      rows = fetched;
      const stored = await read(() =>
        storedIds(
          sql,
          "dokument",
          fetched.map((row) => row.id),
        ),
      );
      batch.dokument = fetched.filter((row) => stored.has(row.id));
      break;
    }
    case "fil": {
      const fetched = await page("Fil", odaParsers.Fil, "");
      rows = fetched;
      const stored = await read(() =>
        storedIds(
          sql,
          "dokument",
          fetched.map((row) => row.dokumentid),
        ),
      );
      batch.fil = fetched.filter((row) => stored.has(row.dokumentid));
      break;
    }
  }
  counts[entity].fetched += rows.length;
  await writeChildren(sql, batch, counts);
  return { rows, counts };
}

/**
 * Step 3: the children of tracked bills (every bill stored in `sag`):
 * Sagstrin (+ type), Afstemning, Stemme (+ type), SagDokument (+ role),
 * Dokument (+ type) and Fil, and the Aktør rows their Stemme rows reference.
 *
 * 1. **Newly tracked bills** get all their children (`newBillsUnit`, in
 *    units of `billsPerUnit` bills). A bill is newly tracked when it has no
 *    `tracked_sag` row first matched before the stored `tracked_sag`
 *    watermark: the database time at which the last completed children
 *    step started. So no extra state is needed, and a bill stored by the
 *    bills or links step of any run whose children step did not complete
 *    is still picked up. On a first run every stored bill is new.
 * 2. **Changed children** of the other tracked bills: for each entity in
 *    `changedChildEntities`, the rows changed since its watermark minus one
 *    hour, by pages, filtered locally to tracked bills
 *    (`changedChildrenUnit`). Skipped on a first run, since phase 1 then
 *    fetched everything after the step started. A run where nothing
 *    changed makes no per-bill requests.
 *
 * Stemme has no changed-since query: a vote has about 179 Stemme rows, and
 * a global query would fetch those of every vote in parliament. Instead a
 * vote's Stemme rows are fetched whenever the vote is new or its
 * `opdateringsdato` changed (ODA writes both together: vote 10204 and its
 * Stemme rows were updated within 20 ms of each other). Aktør rows referenced by Stemme are fetched only
 * when not stored; changes to stored ones come from the links step.
 *
 * New watermarks: `tracked_sag` is the step's start by the database clock.
 * The others are the highest `opdateringsdato` fetched, capped at the
 * step's start and never moved back; on a first run, the step's start.
 */
export async function ingestChildren(
  sql: SqlExecutor,
  options: ChildrenOptions = {},
): Promise<ChildrenResult> {
  const {
    signal,
    pageSize = defaultBillPageSize,
    billsPerUnit = defaultChildrenBillsPerUnit,
    now = Date.now,
  } = options;
  const counts = emptyCounts(childrenEntities);

  let cursor: ChildrenCursor;
  if (options.cursor) cursor = options.cursor;
  else {
    const given = options.since ?? {};
    const keys = ["tracked_sag", ...changedChildEntities] as const;
    const complete = keys.every((key) => given[key] !== undefined);
    cursor = {
      startedAt: new Date(now()).toISOString(),
      trackedFrom: (await fromDatabase(() => databaseNow(sql))).toISOString(),
      since: complete
        ? (Object.fromEntries(
            keys.map((key) => [key, (given[key] as Date).toISOString()]),
          ) as ChildrenCursor["since"])
        : null,
      sessionIds: await fromDatabase(() =>
        sessionIdsFrom(sql, firstSessionStart),
      ),
      afterSagId: 0,
      entityIndex: complete ? 0 : changedChildEntities.length,
      afterId: 0,
      highest: {},
    };
  }

  while (cursor.afterSagId !== null) {
    if (shouldStop(options)) return { done: false, cursor, counts };
    const sagIds = await fromDatabase(() =>
      sagIdsTrackedSince(
        sql,
        parseIso(cursor.since?.tracked_sag ?? null),
        cursor.afterSagId ?? 0,
        billsPerUnit,
      ),
    );
    if (sagIds.length === 0) {
      cursor = { ...cursor, afterSagId: null };
      break;
    }
    let unit: Counts<ChildrenEntity>;
    try {
      unit = await newBillsUnit(sql, sagIds, signal);
    } catch (error) {
      if (error instanceof Stopped) return { done: false, cursor, counts };
      throw error;
    }
    for (const name of childrenEntities)
      add(counts[name], unit[name], unit[name].fetched);
    cursor = { ...cursor, afterSagId: Math.max(...sagIds) };
  }

  while (
    cursor.since !== null &&
    cursor.entityIndex < changedChildEntities.length
  ) {
    const entity = changedChildEntities[cursor.entityIndex];
    if (cursor.sessionIds.length === 0) {
      cursor = { ...cursor, entityIndex: cursor.entityIndex + 1, afterId: 0 };
      continue;
    }
    if (shouldStop(options)) return { done: false, cursor, counts };
    let unit: Awaited<ReturnType<typeof changedChildrenUnit>>;
    try {
      unit = await changedChildrenUnit(
        sql,
        entity,
        cursor,
        changedAfterLiteral(new Date(cursor.since[entity])),
        pageSize,
        signal,
      );
    } catch (error) {
      if (error instanceof Stopped) return { done: false, cursor, counts };
      throw error;
    }
    for (const name of childrenEntities)
      add(counts[name], unit.counts[name], unit.counts[name].fetched);
    const { rows } = unit;
    cursor = {
      ...cursor,
      highest: {
        ...cursor.highest,
        [entity]: highestOf(rows, cursor.highest[entity]),
      },
      ...(rows.length === 0
        ? { entityIndex: cursor.entityIndex + 1, afterId: 0 }
        : { afterId: Math.max(...rows.map((row) => row.id)) }),
    };
  }

  const startedAt = new Date(cursor.startedAt);
  const watermarks = {
    tracked_sag: new Date(cursor.trackedFrom),
    ...Object.fromEntries(
      changedChildEntities.map((entity) => [
        entity,
        nextWatermark(
          startedAt,
          cursor.since?.[entity],
          cursor.highest[entity],
        ),
      ]),
    ),
  } as ChildrenWatermarks;
  return { done: true, counts, watermarks };
}
