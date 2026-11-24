/**
 * Tests for `POST /api/ingest` (`app/api/ingest/route.ts` and
 * `lib/ingest/run.ts`): authorisation, the lease, the time budget, progress
 * and watermarks across calls, failures and the response body. The
 * database is the SQL test harness; the four ingest steps are mocked, so no
 * test in this file reaches ODA or Neon (the step tests are in
 * `ingest-steps.test.ts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import type { SqlExecutor } from "@/lib/db";
import type * as Steps from "@/lib/ingest/steps";
import {
  createMigratedTestDatabase,
  type TestDatabase,
} from "@/tests/support/pglite";

const harness = vi.hoisted(() => ({
  sql: undefined as SqlExecutor | undefined,
  executorFails: false,
  steps: {
    ingestSessions: vi.fn(),
    ingestBills: vi.fn(),
    ingestLinks: vi.fn(),
    ingestChildren: vi.fn(),
  },
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  executor: () => {
    if (harness.executorFails) throw new Error("configuration");
    return harness.sql;
  },
}));
vi.mock("@/lib/ingest/steps", async (importOriginal) => ({
  ...(await importOriginal<typeof Steps>()),
  ...harness.steps,
}));

const { POST, dynamic, maxDuration } = await import("@/app/api/ingest/route");
const { IngestError, ingestErrors } = await import("@/lib/ingest/steps");
const { readWatermarks } = await import("@/lib/ingest/repository");
const { defaultBudgetMs, ingestEntities, leaseSeconds, runErrors, runIngest } =
  await import("@/lib/ingest/run");

const secret = "cron-secret-9b2e4d";
const url = "http://localhost/api/ingest";
const steps = harness.steps;

let database: TestDatabase;

beforeAll(async () => {
  database = await createMigratedTestDatabase();
  harness.sql = database.sql;
});

afterAll(async () => {
  await database?.close();
});

function request(authorization?: string, method = "POST"): Request {
  return new Request(url, {
    method,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
}

const authorised = () => request(`Bearer ${secret}`);

const counts = (fetched: number, inserted = 0, updated = 0, unchanged = 0) => ({
  fetched,
  inserted,
  updated,
  unchanged,
});

// Watermarks the fake steps produce, and older ones stored before a run.
const before = new Date("2026-11-01T00:00:00.000Z");
const produced = new Date("2026-11-20T00:00:00.000Z");
const linksEntities = ["sag_aktoer", "emneord_sag", "aktoer", "emneord"];
const childrenEntities = [
  "tracked_sag",
  "sagstrin",
  "afstemning",
  "sag_dokument",
  "dokument",
  "fil",
];
const allWatermarks = (date: Date) =>
  Object.fromEntries(
    ["sag", ...linksEntities, ...childrenEntities].map((entity) => [
      entity,
      date,
    ]),
  );

/** Every step finishes at once, with a few counts and the watermarks. */
function stepsFinish() {
  steps.ingestSessions.mockResolvedValue({
    done: true,
    counts: { periode: counts(4, 0, 0, 4) },
  });
  steps.ingestBills.mockResolvedValue({
    done: true,
    counts: { sag: counts(2, 1, 1), aktoer: counts(1, 1) },
    watermark: produced,
  });
  steps.ingestLinks.mockResolvedValue({
    done: true,
    counts: { aktoer: counts(3, 0, 1, 2) },
    watermarks: Object.fromEntries(linksEntities.map((e) => [e, produced])),
  });
  steps.ingestChildren.mockResolvedValue({
    done: true,
    counts: { sagstrin: counts(5, 5), aktoer: counts(1, 1) },
    watermarks: Object.fromEntries(childrenEntities.map((e) => [e, produced])),
  });
}

async function runs() {
  return database.sql.query(
    `SELECT id, status, finished_at, lease_expires_at, counts, watermarks,
            progress, error
     FROM ingest_run ORDER BY id`,
  );
}

/** Stores a completed run with the given watermarks (as a script would). */
async function storeCompletedRun(watermarks: Record<string, Date>) {
  await database.sql.query(
    `INSERT INTO ingest_run (status, finished_at, lease_expires_at, watermarks)
     VALUES ('completed', now(), now(), $1::jsonb)`,
    [JSON.stringify(watermarks)],
  );
}

beforeEach(async () => {
  await database.pg.exec("TRUNCATE ingest_run, blob_op");
  vi.stubEnv("VERCEL_ENV", "development");
  vi.stubEnv("CRON_SECRET", secret);
  // Fail loudly if anything tries real network access.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network access in unit test");
    }),
  );
  harness.executorFails = false;
  for (const step of Object.values(steps)) step.mockReset();
  stepsFinish();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectNoStepRun() {
  for (const step of Object.values(steps)) expect(step).not.toHaveBeenCalled();
}

describe("route configuration", () => {
  it("is always dynamic, with a 300 s maximum duration", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(300);
  });

  it("keeps the budget and the lease within and beyond the maximum duration", () => {
    expect(defaultBudgetMs).toBe(240_000);
    expect(leaseSeconds).toBeGreaterThan(maxDuration);
  });
});

describe("unauthorised requests", () => {
  async function expectUnauthorised(response: Response) {
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expectNoStepRun();
    expect(await runs()).toEqual([]);
  }

  it("returns 401 without an Authorization header", async () => {
    await expectUnauthorised(await POST(request()));
  });

  it("returns 401 with a wrong secret", async () => {
    await expectUnauthorised(await POST(request("Bearer wrong-secret")));
  });

  it("returns 401 when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    await expectUnauthorised(await POST(request("Bearer ")));
    await expectUnauthorised(await POST(request("Bearer undefined")));
  });
});

describe("a completed run", () => {
  it("returns 200 with the spec's JSON shape", async () => {
    // Two Blob operations this month, one in the previous month.
    await database.sql.query(
      `INSERT INTO blob_op (op, at) VALUES ('put', now()), ('put', now()),
         ('put', date_trunc('month', now(), 'UTC') - interval '1 second')`,
    );
    const response = await POST(authorised());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    const [run] = await runs();
    const zero = counts(0);
    expect(body).toEqual({
      environment: "development",
      runId: Number(run?.id),
      done: true,
      counts: {
        ...Object.fromEntries(ingestEntities.map((entity) => [entity, zero])),
        periode: counts(4, 0, 0, 4),
        sag: counts(2, 1, 1),
        aktoer: counts(5, 2, 1, 2),
        sagstrin: counts(5, 5),
      },
      files: { stored: 0, unchanged: 0, deferred: 0, skipped: 0 },
      blobOperationsThisMonth: 2,
    });
    expect(Object.keys(body.counts)).toEqual([...ingestEntities]);
  });

  it("records the row as completed, with its counts and watermarks", async () => {
    await POST(authorised());
    const [run] = await runs();
    expect(run?.status).toBe("completed");
    expect(run?.finished_at).not.toBeNull();
    expect(run?.progress).toBeNull();
    expect(run?.error).toBeNull();
    expect((run?.counts as Record<string, unknown>).sagstrin).toEqual(
      counts(5, 5),
    );
    expect(await readWatermarks(database.sql)).toEqual(allWatermarks(produced));
  });

  it("starts each step from the stored watermarks", async () => {
    await storeCompletedRun(allWatermarks(before));
    await POST(authorised());

    expect(steps.ingestBills.mock.calls[0]?.[1]).toMatchObject({
      since: before,
    });
    expect(steps.ingestLinks.mock.calls[0]?.[1]).toMatchObject({
      since: allWatermarks(before),
      initialSince: before,
    });
    expect(steps.ingestChildren.mock.calls[0]?.[1]).toMatchObject({
      since: allWatermarks(before),
    });
  });

  it("gives the links step the bills step's watermark on a first run", async () => {
    await POST(authorised());
    const links = steps.ingestLinks.mock.calls[0]?.[1];
    expect(links.since).toEqual({});
    expect(links.initialSince).toEqual(produced);
    expect(steps.ingestBills.mock.calls[0]?.[1].since).toBeUndefined();
  });

  it("starts a new run after a completed one", async () => {
    await POST(authorised());
    await POST(authorised());
    expect(steps.ingestSessions).toHaveBeenCalledTimes(2);
    expect(steps.ingestBills.mock.calls[1]?.[1]).toMatchObject({
      since: produced,
    });
  });
});

describe("the lease", () => {
  it("returns 409 while another lease is active, and runs nothing", async () => {
    await database.sql.query(
      `INSERT INTO ingest_run (status, lease_expires_at)
       VALUES ('running', now() + interval '5 minutes')`,
    );
    const response = await POST(authorised());

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error).toBe(runErrors.busy);
    expect(body.runId).toBeNull();
    expectNoStepRun();
    expect((await runs()).map((run) => run.status)).toEqual(["running"]);
  });

  it("returns 409 to a second call while the first one runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    steps.ingestSessions.mockImplementation(async () => {
      await gate;
      return { done: true, counts: { periode: counts(0) } };
    });
    const first = POST(authorised());
    await vi.waitFor(() => expect(steps.ingestSessions).toHaveBeenCalled());

    expect((await POST(authorised())).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(steps.ingestSessions).toHaveBeenCalledTimes(1);
  });

  it("takes over an expired lease", async () => {
    await database.sql.query(
      `INSERT INTO ingest_run (status, lease_expires_at)
       VALUES ('running', now() - interval '1 second')`,
    );
    const response = await POST(authorised());

    expect(response.status).toBe(200);
    expect((await response.json()).done).toBe(true);
    const [expired, taken] = await runs();
    expect(expired?.status).toBe("expired");
    expect(expired?.error).toBe(runErrors.expired);
    expect(expired?.finished_at).not.toBeNull();
    expect(taken?.status).toBe("completed");
  });

  it("holds the lease for longer than the function may run", async () => {
    steps.ingestSessions.mockImplementation(async () => {
      const [row] = await database.sql.query(
        `SELECT extract(epoch FROM lease_expires_at - started_at)::int AS s
         FROM ingest_run WHERE status = 'running'`,
      );
      expect(row?.s).toBe(leaseSeconds);
      return { done: true, counts: { periode: counts(0) } };
    });
    expect((await POST(authorised())).status).toBe(200);
  });
});

describe("the time budget", () => {
  let clock: number;

  beforeEach(() => {
    clock = Date.parse("2026-11-24T10:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  it("stops after the current step when the budget runs out (fake clock)", async () => {
    steps.ingestSessions.mockImplementation(async () => {
      clock += defaultBudgetMs;
      return { done: true, counts: { periode: counts(4, 4) } };
    });
    const response = await POST(authorised());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.done).toBe(false);
    expect(body.counts.periode).toEqual(counts(4, 4));
    expect(steps.ingestBills).not.toHaveBeenCalled();
    const [run] = await runs();
    expect(run?.status).toBe("stopped");
    expect(run?.watermarks).toEqual({});
    expect(run?.progress).toMatchObject({ step: "bills", cursor: null });
  });

  it("passes the deadline and clock to the steps, and saves a step's cursor", async () => {
    const cursor = { afterId: 42 };
    steps.ingestBills.mockImplementation(async (_sql, options) => {
      expect(options.deadline).toBe(clock + defaultBudgetMs);
      expect(options.now()).toBe(clock);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      clock = options.deadline;
      return { done: false, cursor, counts: { sag: counts(100, 3) } };
    });
    const body = await (await POST(authorised())).json();

    expect(body.done).toBe(false);
    expect(body.counts.sag).toEqual(counts(100, 3));
    expect(steps.ingestLinks).not.toHaveBeenCalled();
    const [run] = await runs();
    expect(run?.progress).toMatchObject({ step: "bills", cursor });

    // The next call continues the bills step from its cursor.
    clock += 60_000;
    stepsFinish();
    const next = await (await POST(authorised())).json();
    expect(next.done).toBe(true);
    expect(steps.ingestSessions).toHaveBeenCalledTimes(1);
    expect(steps.ingestBills.mock.calls[1]?.[1]).toMatchObject({ cursor });
  });

  it("aborts a running unit with the signal after abortAfterMs", async () => {
    vi.restoreAllMocks();
    steps.ingestSessions.mockImplementation(
      (_sql, options: { signal: AbortSignal }) =>
        new Promise((resolve) =>
          options.signal.addEventListener("abort", () =>
            resolve({ done: false, counts: { periode: counts(0) } }),
          ),
        ),
    );
    const result = await runIngest(database.sql, { abortAfterMs: 20 });
    expect(result.status).toBe("stopped");
    expect(result.report.done).toBe(false);
    expect((await runs())[0]?.progress).toMatchObject({ step: "sessions" });
  });
});

describe("progress and watermarks across calls", () => {
  it("keeps the pre-run watermarks until the run completes", async () => {
    await storeCompletedRun(allWatermarks(before));
    const billsCursor = { afterId: 1 };
    const linksCursor = { entityIndex: 2 };

    // Call 1: the bills step stops.
    steps.ingestBills.mockResolvedValueOnce({
      done: false,
      cursor: billsCursor,
      counts: {},
    });
    expect((await (await POST(authorised())).json()).done).toBe(false);

    // Call 2: the bills step finishes, the links step stops.
    steps.ingestLinks.mockResolvedValueOnce({
      done: false,
      cursor: linksCursor,
      counts: {},
    });
    expect((await (await POST(authorised())).json()).done).toBe(false);
    expect(steps.ingestBills.mock.calls[1]?.[1]).toMatchObject({
      cursor: billsCursor,
    });
    // The links step starts from the pre-run `sag` watermark, not the one
    // the bills step just produced.
    expect(steps.ingestLinks.mock.calls[0]?.[1]).toMatchObject({
      since: allWatermarks(before),
      initialSince: before,
    });
    // Stopped calls store no watermarks.
    expect(await readWatermarks(database.sql)).toEqual(allWatermarks(before));

    // Call 3: the links and children steps finish.
    expect((await (await POST(authorised())).json()).done).toBe(true);
    expect(steps.ingestLinks.mock.calls[1]?.[1]).toMatchObject({
      cursor: linksCursor,
    });
    expect(steps.ingestChildren.mock.calls[0]?.[1]).toMatchObject({
      since: allWatermarks(before),
    });
    expect(await readWatermarks(database.sql)).toEqual(allWatermarks(produced));
    expect(steps.ingestSessions).toHaveBeenCalledTimes(1);
    expect((await runs()).map((run) => run.status)).toEqual([
      "completed",
      "stopped",
      "stopped",
      "completed",
    ]);
  });

  it("continues from an expired call's last saved progress", async () => {
    await database.sql.query(
      `INSERT INTO ingest_run (status, lease_expires_at, progress)
       VALUES ('running', now() - interval '1 second', $1::jsonb)`,
      [
        JSON.stringify({
          since: { sag: before.toISOString() },
          watermarks: { sag: produced.toISOString() },
          step: "links",
          cursor: null,
        }),
      ],
    );
    expect((await (await POST(authorised())).json()).done).toBe(true);
    expect(steps.ingestSessions).not.toHaveBeenCalled();
    expect(steps.ingestBills).not.toHaveBeenCalled();
    expect(steps.ingestLinks.mock.calls[0]?.[1]).toMatchObject({
      since: { sag: before },
      initialSince: before,
    });
  });

  it("ignores an earlier call that saved no progress", async () => {
    await storeCompletedRun(allWatermarks(before));
    await database.sql.query(
      `INSERT INTO ingest_run (status, lease_expires_at, progress)
       VALUES ('stopped', now(), $1::jsonb), ('failed', now(), NULL)`,
      [
        JSON.stringify({
          since: {},
          watermarks: {},
          step: "children",
          cursor: null,
        }),
      ],
    );
    await POST(authorised());
    expect(steps.ingestSessions).not.toHaveBeenCalled();
    expect(steps.ingestChildren).toHaveBeenCalledTimes(1);
  });
});

describe("a failing step", () => {
  it("returns 500 with a fixed error and marks the row failed", async () => {
    steps.ingestLinks.mockRejectedValueOnce(new IngestError(ingestErrors.oda));
    const response = await POST(authorised());

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error).toBe(ingestErrors.oda);
    expect(body.done).toBe(false);
    expect(body.counts.sag).toEqual(counts(2, 1, 1));
    expect(steps.ingestChildren).not.toHaveBeenCalled();
    const [run] = await runs();
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe(ingestErrors.oda);
    expect(run?.watermarks).toEqual({});
    expect(run?.progress).toMatchObject({
      step: "links",
      cursor: null,
      watermarks: { sag: produced.toISOString() },
    });
  });

  it("is redone from the cursor it started with by the next call", async () => {
    const cursor = { entityIndex: 1 };
    steps.ingestLinks
      .mockResolvedValueOnce({ done: false, cursor, counts: {} })
      .mockRejectedValueOnce(new IngestError(ingestErrors.database));
    await POST(authorised());
    expect((await POST(authorised())).status).toBe(500);
    const third = await POST(authorised());

    expect(third.status).toBe(200);
    expect((await third.json()).done).toBe(true);
    expect(steps.ingestLinks.mock.calls[1]?.[1]).toMatchObject({ cursor });
    expect(steps.ingestLinks.mock.calls[2]?.[1]).toMatchObject({ cursor });
    expect(steps.ingestBills).toHaveBeenCalledTimes(1);
    expect((await runs()).map((run) => run.status)).toEqual([
      "stopped",
      "failed",
      "completed",
    ]);
  });

  it("never passes an unexpected error's message on", async () => {
    steps.ingestChildren.mockRejectedValueOnce(
      new Error(`driver said postgresql://user:${secret}@host/db`),
    );
    const response = await POST(authorised());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text).error).toBe(runErrors.unexpected);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("driver");
    expect((await runs())[0]?.error).toBe(runErrors.unexpected);
  });

  it("returns 500 without running anything when the database is not configured", async () => {
    harness.executorFails = true;
    const response = await POST(authorised());
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe(
      "configuration missing or invalid",
    );
    expectNoStepRun();
  });
});

describe("other methods", () => {
  it("exports only POST, so GET runs nothing", async () => {
    const route = await import("@/app/api/ingest/route");
    expect("GET" in route).toBe(false);
  });
});

describe("no environment value in any response", () => {
  // Every variable in `.env.example`, read at runtime so this file does not
  // name the blob variables (see boundaries.test.ts).
  const names = readFileSync(
    join(import.meta.dirname, "..", "..", ".env.example"),
    "utf8",
  )
    .split("\n")
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

  const fakes = Object.fromEntries(
    names.map((name) => [
      name,
      name.startsWith("DATABASE_URL")
        ? `postgresql://fakeuser:fakepw-${name}@fake-host-${name}.example/fakedb`
        : `fake-value-${name}-7c1a`,
    ]),
  );

  beforeEach(() => {
    for (const [name, value] of Object.entries(fakes)) vi.stubEnv(name, value);
  });

  async function expectNoValues(response: Response) {
    const text = `${await response.text()} ${JSON.stringify([...response.headers])}`;
    for (const [name, value] of Object.entries(fakes))
      expect(text, `value of ${name}`).not.toContain(value);
  }

  it("covers CRON_SECRET and DATABASE_URL", () => {
    expect(names).toContain("CRON_SECRET");
    expect(names).toContain("DATABASE_URL");
  });

  it("holds for 401, 200, 409 and 500 responses", async () => {
    const bearer = `Bearer ${fakes.CRON_SECRET}`;
    const unauthorised = await POST(request("Bearer wrong"));
    expect(unauthorised.status).toBe(401);
    await expectNoValues(unauthorised);

    const ok = await POST(request(bearer));
    expect(ok.status).toBe(200);
    await expectNoValues(ok);

    steps.ingestSessions.mockRejectedValueOnce(
      new Error(`leak ${fakes.DATABASE_URL} ${fakes.GEMINI_API_KEY}`),
    );
    const failed = await POST(request(bearer));
    expect(failed.status).toBe(500);
    await expectNoValues(failed);

    await database.sql.query(
      `INSERT INTO ingest_run (status, lease_expires_at)
       VALUES ('running', now() + interval '5 minutes')`,
    );
    const busy = await POST(request(bearer));
    expect(busy.status).toBe(409);
    await expectNoValues(busy);
  });
});
