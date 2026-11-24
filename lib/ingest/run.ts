/**
 * One call of `POST /api/ingest` (spec 002, deliverable 5): takes the lease,
 * runs the ingest steps in order within a time budget, saves where it
 * stopped and reports what it did. Independent of the route, so a Workflow
 * (phase 8) can run the same function. See `docs/ingest.md`.
 *
 * - **Lease.** One `ingest_run` row per call. A row with status `running` is
 *   the lease; a partial unique index allows only one. Taking it marks a
 *   running row whose `lease_expires_at` has passed as `expired` and inserts
 *   the new row, in one transaction. A unique violation means another call
 *   holds a live lease: `busy`. The lease lasts longer than the function may
 *   run, so a live call is never taken over.
 * - **Progress.** A backfill spans several calls. Each call continues from
 *   the latest earlier row that is `completed` or has `progress`: after a
 *   completed row it starts a new run, otherwise it continues that row's
 *   `progress` (the step to run, its cursor, the watermarks the run started
 *   from and those its finished steps produced). Progress is saved when the
 *   call starts, after each finished step and when it stops.
 * - **Watermarks.** Every call of a run starts each step from the watermarks
 *   stored before the run began (`progress.since`), so the links step's
 *   `initialSince` is the pre-run `sag` watermark, never one the bills step
 *   just produced. Watermarks produced by finished steps are kept in
 *   `progress` and written to `ingest_run.watermarks` only by the call that
 *   completes the run, so `readWatermarks` never sees a partial run's.
 * - **Budget.** No step or unit starts after `budgetMs`; a unit that runs
 *   into `abortAfterMs` is stopped by the signal (it wrote nothing and is
 *   redone). The call then saves progress and reports `done: false`.
 * - **Failure.** A step that throws marks the row `failed` with a fixed error
 *   and the progress from before that step's call, so the next call redoes
 *   the step from the cursor it started this call with (upserts are
 *   idempotent).
 */
import { type Environment, config } from "@/lib/config";
import type { SqlExecutor } from "@/lib/db";
import { type WatermarkEntity, readWatermarks } from "@/lib/ingest/repository";
import {
  type BillsCursor,
  type BillsEntity,
  type ChildrenCursor,
  type ChildrenEntity,
  type Counts,
  type EntityCounts,
  type LinksCursor,
  type SessionsEntity,
  type StepOptions,
  IngestError,
  ingestBills,
  ingestChildren,
  ingestErrors,
  ingestLinks,
  ingestSessions,
} from "@/lib/ingest/steps";

/** Default time budget of a call: no step or unit starts after it. */
export const defaultBudgetMs = 240_000;

/**
 * Default time after which a running ODA request is aborted, leaving time
 * to save progress within the function's 300 s limit.
 */
export const defaultAbortAfterMs = 270_000;

/** How long a lease lasts: twice the function's maximum duration. */
export const leaseSeconds = 600;

/** The steps, in the order they run. The file step (#38) goes last. */
export const ingestStepNames = [
  "sessions",
  "bills",
  "links",
  "children",
] as const;
export type IngestStepName = (typeof ingestStepNames)[number];

/** Every entity in the report's `counts`, in step order. */
export const ingestEntities = [
  "periode",
  "sag",
  "sag_aktoer",
  "aktoer",
  "emneord",
  "emneord_sag",
  "tracked_sag",
  "sagstrin",
  "afstemning",
  "stemme",
  "sag_dokument",
  "dokument",
  "fil",
] as const satisfies readonly (SessionsEntity | BillsEntity | ChildrenEntity)[];
export type IngestEntity = (typeof ingestEntities)[number];

/** Fixed error messages of a call, on top of the steps' `ingestErrors`. */
export const runErrors = {
  busy: "another ingest run is in progress",
  expired: "lease expired",
  unexpected: "ingest failed",
} as const;

/** The file step's counts. All zero until the file step (#38) exists. */
export type FileCounts = {
  stored: number;
  unchanged: number;
  deferred: number;
  skipped: number;
};

/** The route's response body (spec 002, deliverable 5). */
export type IngestReport = {
  /** `null` only if `VERCEL_ENV` holds an unknown value. */
  environment: Environment | null;
  /** This call's `ingest_run` id, or null if no row was created. */
  runId: number | null;
  /** True when the run completed; false: call again. */
  done: boolean;
  /** What this call did, per entity. */
  counts: Record<IngestEntity, EntityCounts>;
  files: FileCounts;
  /** `blob_op` rows in the current UTC calendar month, or null if unknown. */
  blobOperationsThisMonth: number | null;
  /** A fixed string, only when the call failed. */
  error?: string;
};

export type IngestRunResult =
  | { status: "busy"; report: IngestReport }
  | { status: "completed" | "stopped" | "failed"; report: IngestReport };

type IsoWatermarks = Partial<Record<WatermarkEntity, string>>;

/**
 * Where a run continues. Stored as JSON in `ingest_run.progress`.
 */
export type RunProgress = {
  /** The watermarks stored before the run began (ISO). */
  since: IsoWatermarks;
  /** Watermarks produced by the steps finished so far (ISO). */
  watermarks: IsoWatermarks;
  /** The step to run next. */
  step: IngestStepName;
  /** That step's cursor, or null to start it. */
  cursor: BillsCursor | LinksCursor | ChildrenCursor | null;
};

export type RunOptions = {
  /** No step or unit starts this long after the call started. */
  budgetMs?: number;
  /** A running ODA request is aborted this long after the call started. */
  abortAfterMs?: number;
  /** The clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

type StepOutcome =
  | { done: false; cursor: RunProgress["cursor"]; counts: Counts<string> }
  | {
      done: true;
      counts: Counts<string>;
      watermarks: Partial<Record<WatermarkEntity, Date>>;
    };

type StepRunner = (
  sql: SqlExecutor,
  progress: RunProgress,
  options: StepOptions,
) => Promise<StepOutcome>;

function sinceDates(
  progress: RunProgress,
): Partial<Record<WatermarkEntity, Date>> {
  return Object.fromEntries(
    Object.entries(progress.since).map(([entity, iso]) => [
      entity,
      new Date(iso),
    ]),
  );
}

/** Runs each step from the run's progress. Add the file step here (#38). */
const stepRunners: Record<IngestStepName, StepRunner> = {
  async sessions(sql, _progress, options) {
    const result = await ingestSessions(sql, options);
    return result.done
      ? { done: true, counts: result.counts, watermarks: {} }
      : { done: false, cursor: null, counts: result.counts };
  },
  async bills(sql, progress, options) {
    const result = progress.cursor
      ? await ingestBills(sql, {
          ...options,
          cursor: progress.cursor as BillsCursor,
        })
      : await ingestBills(sql, { ...options, since: sinceDates(progress).sag });
    if (!result.done)
      return { done: false, cursor: result.cursor, counts: result.counts };
    return {
      done: true,
      counts: result.counts,
      watermarks: result.watermark === null ? {} : { sag: result.watermark },
    };
  },
  async links(sql, progress, options) {
    const since = sinceDates(progress);
    const produced = progress.watermarks.sag;
    const result = progress.cursor
      ? await ingestLinks(sql, {
          ...options,
          cursor: progress.cursor as LinksCursor,
        })
      : await ingestLinks(sql, {
          ...options,
          since,
          initialSince:
            since.sag ??
            (produced === undefined ? undefined : new Date(produced)),
        });
    return result.done
      ? { done: true, counts: result.counts, watermarks: result.watermarks }
      : { done: false, cursor: result.cursor, counts: result.counts };
  },
  async children(sql, progress, options) {
    const result = progress.cursor
      ? await ingestChildren(sql, {
          ...options,
          cursor: progress.cursor as ChildrenCursor,
        })
      : await ingestChildren(sql, { ...options, since: sinceDates(progress) });
    return result.done
      ? { done: true, counts: result.counts, watermarks: result.watermarks }
      : { done: false, cursor: result.cursor, counts: result.counts };
  },
};

function emptyReportCounts(): Record<IngestEntity, EntityCounts> {
  return Object.fromEntries(
    ingestEntities.map((entity) => [
      entity,
      { fetched: 0, inserted: 0, updated: 0, unchanged: 0 },
    ]),
  ) as Record<IngestEntity, EntityCounts>;
}

function addCounts(
  target: Record<IngestEntity, EntityCounts>,
  counts: Counts<string>,
): void {
  for (const [entity, value] of Object.entries(counts)) {
    const sum = target[entity as IngestEntity];
    if (sum === undefined) continue;
    sum.fetched += value.fetched;
    sum.inserted += value.inserted;
    sum.updated += value.updated;
    sum.unchanged += value.unchanged;
  }
}

function toIso(watermarks: Partial<Record<WatermarkEntity, Date>>) {
  return Object.fromEntries(
    Object.entries(watermarks).map(([entity, date]) => [
      entity,
      date.toISOString(),
    ]),
  ) as IsoWatermarks;
}

function safeEnvironment(): Environment | null {
  try {
    return config.environment();
  } catch {
    return null;
  }
}

/** The report of a call that did nothing, e.g. one refused or failed early. */
export function emptyReport(
  error?: string,
  runId: number | null = null,
): IngestReport {
  return {
    environment: safeEnvironment(),
    runId,
    done: false,
    counts: emptyReportCounts(),
    files: { stored: 0, unchanged: 0, deferred: 0, skipped: 0 },
    blobOperationsThisMonth: null,
    ...(error === undefined ? {} : { error }),
  };
}

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function fromDatabase<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch {
    throw new IngestError(ingestErrors.database);
  }
}

/**
 * Takes the lease: marks an expired running row `expired` and inserts a new
 * running row, in one transaction. Returns the new row's id, or null if a
 * live lease is held (unique violation, SQLSTATE 23505).
 */
async function takeLease(sql: SqlExecutor): Promise<number | null> {
  try {
    await sql.transaction([
      {
        text: `UPDATE ingest_run
               SET status = 'expired', finished_at = now(), error = $1
               WHERE status = 'running' AND lease_expires_at <= now()`,
        params: [runErrors.expired],
      },
      {
        text: `INSERT INTO ingest_run (status, lease_expires_at)
               VALUES ('running', now() + make_interval(secs => $1))`,
        params: [leaseSeconds],
      },
    ]);
  } catch (error) {
    if (sqlStateOf(error) === "23505") return null;
    throw new IngestError(ingestErrors.database);
  }
  // The transaction cannot return the id (it is not interactive). The
  // running row is ours: no other call can take it over before it expires.
  const [row] = await fromDatabase(() =>
    sql.query("SELECT id FROM ingest_run WHERE status = 'running'"),
  );
  if (row === undefined) throw new IngestError(ingestErrors.database);
  return Number(row.id);
}

function isProgress(value: unknown): value is RunProgress {
  if (typeof value !== "object" || value === null) return false;
  const progress = value as Record<string, unknown>;
  return (
    ingestStepNames.includes(progress.step as IngestStepName) &&
    typeof progress.since === "object" &&
    progress.since !== null &&
    typeof progress.watermarks === "object" &&
    progress.watermarks !== null &&
    "cursor" in progress
  );
}

/**
 * Where this call starts: the progress of the latest earlier row that is
 * not completed and has progress, or, after a completed row (or none), a
 * new run from the stored watermarks.
 */
async function startingProgress(
  sql: SqlExecutor,
  runId: number,
): Promise<RunProgress> {
  const [previous] = await fromDatabase(() =>
    sql.query(
      `SELECT status, progress FROM ingest_run
       WHERE id < $1 AND (status = 'completed' OR progress IS NOT NULL)
       ORDER BY id DESC
       LIMIT 1`,
      [runId],
    ),
  );
  if (
    previous !== undefined &&
    previous.status !== "completed" &&
    isProgress(previous.progress)
  )
    return previous.progress;
  const stored = await fromDatabase(() => readWatermarks(sql));
  return {
    since: toIso(stored),
    watermarks: {},
    step: ingestStepNames[0],
    cursor: null,
  };
}

async function saveProgress(
  sql: SqlExecutor,
  runId: number,
  progress: RunProgress,
): Promise<void> {
  await fromDatabase(() =>
    sql.query("UPDATE ingest_run SET progress = $2::jsonb WHERE id = $1", [
      runId,
      JSON.stringify(progress),
    ]),
  );
}

/** `blob_op` rows in the current UTC calendar month. */
export async function blobOperationsThisMonth(
  sql: SqlExecutor,
): Promise<number> {
  const [row] = await sql.query(
    `SELECT count(*)::int AS count FROM blob_op
     WHERE at >= date_trunc('month', now(), 'UTC')`,
  );
  return Number(row?.count ?? 0);
}

/**
 * Runs one call: takes the lease, runs the steps from where the run is and
 * records the outcome on this call's `ingest_run` row. Never throws, and
 * never reports anything but fixed error strings.
 */
export async function runIngest(
  sql: SqlExecutor,
  options: RunOptions = {},
): Promise<IngestRunResult> {
  const {
    budgetMs = defaultBudgetMs,
    abortAfterMs = defaultAbortAfterMs,
    now = () => Date.now(),
  } = options;
  const startedAt = now();
  const deadline = startedAt + budgetMs;

  let runId: number | null;
  try {
    runId = await takeLease(sql);
  } catch {
    return { status: "failed", report: emptyReport(ingestErrors.database) };
  }
  if (runId === null)
    return { status: "busy", report: emptyReport(runErrors.busy) };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, abortAfterMs - (now() - startedAt)),
  );
  const stepOptions: StepOptions = {
    signal: controller.signal,
    deadline,
    now,
  };
  const counts = emptyReportCounts();
  let progress: RunProgress | null = null;
  let done = false;
  let error: string | undefined;

  try {
    progress = await startingProgress(sql, runId);
    await saveProgress(sql, runId, progress);
    for (;;) {
      if (controller.signal.aborted || now() >= deadline) break;
      const outcome = await stepRunners[progress.step](
        sql,
        progress,
        stepOptions,
      );
      addCounts(counts, outcome.counts);
      if (!outcome.done) {
        progress = { ...progress, cursor: outcome.cursor };
        break;
      }
      const watermarks: IsoWatermarks = {
        ...progress.watermarks,
        ...toIso(outcome.watermarks),
      };
      const next: IngestStepName | undefined =
        ingestStepNames[ingestStepNames.indexOf(progress.step) + 1];
      if (next === undefined) {
        progress = { ...progress, watermarks };
        done = true;
        break;
      }
      progress = { ...progress, step: next, cursor: null, watermarks };
      await saveProgress(sql, runId, progress);
    }
  } catch (caught) {
    // Our own fixed messages only; anything else may carry driver or ODA text.
    error =
      caught instanceof IngestError ? caught.message : runErrors.unexpected;
  } finally {
    clearTimeout(timer);
  }

  const status =
    error !== undefined ? "failed" : done ? "completed" : "stopped";
  let blobOperations: number | null = null;
  try {
    blobOperations = await blobOperationsThisMonth(sql);
    await sql.query(
      `UPDATE ingest_run
       SET status = $2, finished_at = now(), counts = $3::jsonb,
           watermarks = $4::jsonb, progress = $5::jsonb, error = $6
       WHERE id = $1`,
      [
        runId,
        status,
        JSON.stringify(counts),
        JSON.stringify(status === "completed" ? progress?.watermarks : {}),
        status === "completed" || progress === null
          ? null
          : JSON.stringify(progress),
        error ?? null,
      ],
    );
  } catch {
    // The row stays `running` and its lease expires; its last saved
    // progress still holds, so a later call continues from there.
    return {
      status: "failed",
      report: {
        ...emptyReport(ingestErrors.database, runId),
        counts,
        blobOperationsThisMonth: blobOperations,
      },
    };
  }

  return {
    status,
    report: {
      ...emptyReport(error, runId),
      done,
      counts,
      blobOperationsThisMonth: blobOperations,
    },
  };
}
