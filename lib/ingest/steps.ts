/**
 * Ingest steps 1 and 2 (spec 002, deliverable 4): sessions and candidate
 * bills. Plain async functions over a `SqlExecutor`, independent of how they
 * are triggered, so the route (and later a Workflow) can run them as steps.
 *
 * Each step works in units, checks the caller's `AbortSignal` and deadline
 * before every unit, and returns progress:
 *
 * - `{ done: false, cursor }`: stopped between units. Pass `cursor` back to
 *   continue where it stopped. A unit stopped by the signal while it was
 *   fetching wrote nothing, and is redone from the cursor.
 * - `{ done: true }`: finished. The bills step then returns the watermark
 *   for the caller to store (`writeWatermark` in `repository.ts`).
 *
 * Counts cover the work done by that call only. Errors are `IngestError`s
 * with fixed messages; ODA and driver messages are never passed on.
 */
import type { SqlExecutor } from "@/lib/db";
import {
  type Aktoer,
  type Emneord,
  type Sag,
  fetchAktoer,
  fetchEmneordSag,
  fetchPeriode,
  fetchSagAktoer,
  formatOdaTimestamp,
  odaPages,
  odaParsers,
} from "@/lib/oda";
import {
  type UpsertCounts,
  sessionIdsFrom,
  storedSagIds,
  upsertAktoer,
  upsertEmneord,
  upsertEmneordSag,
  upsertPeriode,
  upsertSag,
  upsertSagAktoer,
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

// Aktør ids per request. Keeps each `id eq … or …` filter short.
const aktoerChunkSize = 20;

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
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const rows: Aktoer[] = [];
  for (let start = 0; start < unique.length; start += aktoerChunkSize) {
    const chunk = unique.slice(start, start + aktoerChunkSize);
    const filter = chunk.map((id) => `id eq ${id}`).join(" or ");
    rows.push(...(await fetchAktoer({ filter }, { signal })));
  }
  return rows;
}

/**
 * One unit of the bills step: the next page of changed bills in a session,
 * with their SagAktør (+ role name, + Aktør) and EmneordSag (+ Emneord).
 * Fetches everything first and writes after, so a unit stopped while
 * fetching writes nothing. Returns the page's bills (empty when the session
 * is done) and the unit's counts.
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

  const ids = new Set(bills.map((sag) => sag.id));
  // The same scope as the page, through the Sag navigation property, and
  // limited to the page's id range. Rows of other bills are dropped below.
  const scope = `sagid ge ${Math.min(...ids)} and sagid le ${Math.max(...ids)} and Sag/typeid eq ${lovforslagTypeId} and Sag/periodeid eq ${session}${changed("Sag/opdateringsdato")}`;
  const sagAktoer = (
    await fromOda(signal, () =>
      fetchSagAktoer({ filter: scope, expand: "SagAktørRolle" }, { signal }),
    )
  ).filter((row) => ids.has(row.sagid));
  const emneordSag = (
    await fromOda(signal, () =>
      fetchEmneordSag({ filter: scope, expand: "Emneord" }, { signal }),
    )
  ).filter((row) => ids.has(row.sagid));
  counts.sag_aktoer.fetched = sagAktoer.length;
  counts.emneord_sag.fetched = emneordSag.length;
  counts.emneord.fetched = emneordSag.filter(
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

  // A bill is stored if it is a candidate, or already stored (a tracked bill
  // that stops matching keeps its rows).
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
  counts.aktoer.fetched = ministries.length + others.length;
  const storedAktoer = [...ministries, ...others].filter((aktoer) =>
    referenced.has(aktoer.id),
  );

  const tracked = stored.flatMap(({ sag, matches }) =>
    matches.map((match) => ({
      sagId: sag.id,
      topic: match.topic,
      matching: match.matching,
      matchedRules: match.matchedRules,
    })),
  );
  counts.tracked_sag.fetched = tracked.length;

  await fromDatabase(async () => {
    const sag = await upsertSag(
      sql,
      stored.map(({ sag }) => sag),
    );
    add(counts.sag, sag);
    add(counts.aktoer, await upsertAktoer(sql, storedAktoer));
    add(counts.sag_aktoer, await upsertSagAktoer(sql, storedSagAktoer));
    add(counts.emneord, await upsertEmneord(sql, storedEmneord));
    add(counts.emneord_sag, await upsertEmneordSag(sql, storedEmneordSag));
    add(
      counts.tracked_sag,
      await upsertTrackedSag(sql, tracked, sag.writtenIds),
    );
  });
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
 * EmneordSag rows. Changes to an Aktør or Emneord row alone are picked up
 * the next time the bill changes.
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
