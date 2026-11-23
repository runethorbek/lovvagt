/**
 * `npx tsx --env-file-if-exists=.env.local scripts/ingest-steps.ts`
 *
 * Runs ingest steps 1 to 3 (sessions, candidate bills, links and actors of
 * bills, children of tracked bills; `lib/ingest/steps.ts`) to completion
 * against the database named by `DATABASE_URL` and live ODA, then prints
 * the counts, the number of ODA requests the steps made, the candidate count
 * per topic, whether the known 2024-25 bills are tracked as expected, and
 * the stored and ODA counts of L 211's children with the queries used.
 *
 * Refuses to run unless the environment is `development`. Starts from the
 * stored watermarks, and on success records a `completed` `ingest_run` row
 * with the new ones, so the next run starts from them. It takes no lease:
 * that belongs to `POST /api/ingest`; do not run it while the route runs.
 * Prints no connection details and no driver or ODA error messages. Not run
 * in CI.
 */
import { ConfigError, config } from "@/lib/config";
import { executor } from "@/lib/db";
import {
  type WatermarkEntity,
  readWatermarks,
  recordCompletedRun,
} from "@/lib/ingest/repository";
import {
  type Counts,
  type EntityCounts,
  IngestError,
  ingestBills,
  ingestChildren,
  ingestLinks,
  ingestSessions,
} from "@/lib/ingest/steps";
import { topicRules } from "@/lib/ingest/topics";
import {
  fetchAfstemning,
  fetchSagDokument,
  fetchSagstrin,
  odaBaseUrl,
  odaQueryUrl,
} from "@/lib/oda";

/** Known 2024-25 bills (Sag ids) and their expected topics (spec 002). */
const knownBills = [
  { nummer: "L 154", sagId: 101039, topic: "ai" },
  { nummer: "L 152", sagId: 101043, topic: "ai" },
  { nummer: "L 141", sagId: 69354, topic: "security" },
  { nummer: "L 211", sagId: 101687, topic: "defence" },
  { nummer: "L 188", sagId: 101403, topic: "defence" },
  { nummer: "L 210", sagId: 101688, topic: "defence" },
  { nummer: "L 31", sagId: 99215, topic: null },
] as const;

/** L 211 (2024-25), whose children are compared with ODA (issue #37). */
const l211 = 101687;

// ODA requests made through `fetch`, counted by URL prefix. Database
// requests (Neon over HTTP) also use `fetch` and are not counted.
let odaRequests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(`${odaBaseUrl}/`)) odaRequests += 1;
  return realFetch(input, init);
};

type StepResult = { done: boolean; counts: Counts<string> };

/** Calls a step until it is done, summing its counts. */
async function untilDone<R extends StepResult>(
  first: () => Promise<R>,
  next: (previous: Extract<R, { done: false }>) => Promise<R>,
): Promise<{ result: R; total: Counts<string>; calls: number }> {
  let result = await first();
  let calls = 1;
  const total: Counts<string> = {};
  for (;;) {
    for (const [entity, counts] of Object.entries(result.counts)) {
      const sum = (total[entity] ??= {
        fetched: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
      });
      sum.fetched += counts.fetched;
      sum.inserted += counts.inserted;
      sum.updated += counts.updated;
      sum.unchanged += counts.unchanged;
    }
    if (result.done) return { result, total, calls };
    result = await next(result as Extract<R, { done: false }>);
    calls += 1;
  }
}

function printCounts(counts: Counts<string>): void {
  for (const [
    entity,
    { fetched, inserted, updated, unchanged },
  ] of Object.entries(counts))
    console.log(
      `  ${entity}: fetched ${fetched}, inserted ${inserted}, updated ${updated}, unchanged ${unchanged}`,
    );
}

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    console.error(
      "usage: npx tsx --env-file-if-exists=.env.local scripts/ingest-steps.ts",
    );
    return 2;
  }
  const environment = config.environment();
  if (environment !== "development") {
    console.error(`refusing to ingest into the ${environment} database`);
    return 2;
  }
  const sql = executor();

  console.log(`Ingesting into the ${environment} database`);
  const sessions = await ingestSessions(sql);
  console.log("Sessions:");
  printCounts(sessions.counts);
  if (!sessions.done) {
    console.error("sessions step did not finish");
    return 1;
  }

  const startedAt = new Date();
  const stored = await readWatermarks(sql);
  const watermarks: Partial<Record<WatermarkEntity, Date>> = {};
  const runCounts: Record<string, Counts<string>> = {
    sessions: sessions.counts,
  };

  console.log(`Bills since: ${stored.sag?.toISOString() ?? "(first run)"}`);
  const bills = await untilDone(
    () => ingestBills(sql, { since: stored.sag }),
    (previous) => ingestBills(sql, { cursor: previous.cursor }),
  );
  console.log(`Bills (${bills.calls} call(s)):`);
  printCounts(bills.total);
  runCounts.bills = bills.total;
  if (bills.result.done && bills.result.watermark !== null)
    watermarks.sag = bills.result.watermark;

  const links = await untilDone(
    () =>
      ingestLinks(sql, {
        since: stored,
        initialSince: stored.sag ?? watermarks.sag,
      }),
    (previous) => ingestLinks(sql, { cursor: previous.cursor }),
  );
  console.log(`Links and actors (${links.calls} call(s)):`);
  printCounts(links.total);
  runCounts.links = links.total;
  if (links.result.done) Object.assign(watermarks, links.result.watermarks);

  console.log(
    `Children since: ${stored.tracked_sag?.toISOString() ?? "(first run)"}`,
  );
  const children = await untilDone(
    () => ingestChildren(sql, { since: stored }),
    (previous) => ingestChildren(sql, { cursor: previous.cursor }),
  );
  console.log(`Children (${children.calls} call(s)):`);
  printCounts(children.total);
  runCounts.children = children.total;
  if (children.result.done)
    Object.assign(watermarks, children.result.watermarks);

  console.log(`ODA requests made by the steps: ${odaRequests}`);
  const writes = [bills.total, links.total, children.total]
    .flatMap((total) => Object.values(total))
    .reduce(
      (sum, counts: EntityCounts) => sum + counts.inserted + counts.updated,
      0,
    );
  console.log(`Rows inserted or updated: ${writes}`);

  const runId = await recordCompletedRun(sql, startedAt, runCounts, watermarks);
  console.log(`Recorded completed ingest_run ${runId} with watermarks:`);
  for (const [entity, date] of Object.entries(watermarks))
    console.log(`  ${entity}: ${date.toISOString()}`);

  const perTopic = await sql.query(
    `SELECT topic, count(*)::int AS count FROM tracked_sag
     WHERE matching GROUP BY topic`,
  );
  const [distinct] = await sql.query(
    "SELECT count(DISTINCT sag_id)::int AS count FROM tracked_sag WHERE matching",
  );
  console.log(`Candidates (distinct bills): ${Number(distinct?.count ?? 0)}`);
  for (const { topic } of topicRules) {
    const row = perTopic.find((entry) => entry.topic === topic);
    console.log(`  ${topic}: ${Number(row?.count ?? 0)}`);
  }

  const tracked = await sql.query(
    `SELECT s.id, s.nummer, s.periodeid, t.topic
     FROM sag s JOIN tracked_sag t ON t.sag_id = s.id AND t.matching
     WHERE s.id IN (SELECT jsonb_array_elements_text($1::jsonb)::integer)
     ORDER BY s.id, t.topic`,
    [JSON.stringify(knownBills.map((bill) => bill.sagId))],
  );
  console.log("Known 2024-25 bills:");
  let ok = true;
  for (const bill of knownBills) {
    const rows = tracked.filter((row) => Number(row.id) === bill.sagId);
    const topics = rows.map((row) => String(row.topic));
    const sameBill = rows.every(
      (row) => row.nummer === bill.nummer && Number(row.periodeid) === 163,
    );
    const expected =
      bill.topic === null ? topics.length === 0 : topics.includes(bill.topic);
    if (!expected || !sameBill) ok = false;
    console.log(
      `  ${expected && sameBill ? "ok  " : "FAIL"} ${bill.nummer} (Sag ${bill.sagId}): ${
        topics.length > 0 ? `tracked as ${topics.join(", ")}` : "not tracked"
      }; expected ${bill.topic ?? "not tracked"}`,
    );
  }
  return (await compareL211(sql)) && ok ? 0 : 1;
}

/**
 * Prints the stored and the ODA counts of L 211's stages, votes, documents
 * and files, with the queries used, and returns whether they match.
 */
async function compareL211(sql: ReturnType<typeof executor>): Promise<boolean> {
  const sagstrinQuery = { filter: `sagid eq ${l211}` };
  const afstemningQuery = { filter: `Sagstrin/sagid eq ${l211}` };
  const sagDokumentQuery = {
    filter: `sagid eq ${l211}`,
    expand: "Dokument/Fil",
  };
  const sagstrin = await fetchSagstrin(sagstrinQuery);
  const afstemning = await fetchAfstemning(afstemningQuery);
  const sagDokument = await fetchSagDokument(sagDokumentQuery);
  const dokumentIds = new Set(sagDokument.map((row) => row.dokumentid));
  const filIds = new Set(
    sagDokument.flatMap((row) =>
      (row.dokument?.fil ?? []).map((fil) => fil.id),
    ),
  );

  const count = async (text: string) => {
    const [row] = await sql.query(text, [l211]);
    return Number(row?.count ?? 0);
  };
  const checks = [
    {
      name: "sagstrin",
      oda: sagstrin.length,
      url: odaQueryUrl("Sagstrin", sagstrinQuery),
      sql: "SELECT count(*)::int AS count FROM sagstrin WHERE sagid = $1",
    },
    {
      name: "afstemning",
      oda: afstemning.length,
      url: odaQueryUrl("Afstemning", afstemningQuery),
      sql: `SELECT count(*)::int AS count FROM afstemning
            WHERE sagstrinid IN (SELECT id FROM sagstrin WHERE sagid = $1)`,
    },
    {
      name: "sag_dokument",
      oda: sagDokument.length,
      url: odaQueryUrl("SagDokument", sagDokumentQuery),
      sql: "SELECT count(*)::int AS count FROM sag_dokument WHERE sagid = $1",
    },
    {
      name: "dokument",
      oda: dokumentIds.size,
      url: "(the SagDokument query above: distinct dokumentid)",
      sql: `SELECT count(*)::int AS count FROM dokument
            WHERE id IN (SELECT dokumentid FROM sag_dokument WHERE sagid = $1)`,
    },
    {
      name: "fil",
      oda: filIds.size,
      url: "(the SagDokument query above: distinct Dokument/Fil ids)",
      sql: `SELECT count(*)::int AS count FROM fil
            WHERE dokumentid IN (SELECT dokumentid FROM sag_dokument WHERE sagid = $1)`,
    },
  ];
  console.log(`L 211 (Sag ${l211}) children, stored vs ODA:`);
  let ok = true;
  for (const check of checks) {
    const stored = await count(check.sql);
    if (stored !== check.oda) ok = false;
    console.log(
      `  ${stored === check.oda ? "ok  " : "FAIL"} ${check.name}: stored ${stored}, ODA ${check.oda}`,
    );
    console.log(`       ODA: ${check.url}`);
    console.log(`       SQL: ${check.sql.replace(/\s+/g, " ")}`);
  }
  return ok;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Only our own fixed messages are printed. Anything else could carry
    // driver or ODA text, so it is reported generically.
    console.error(
      error instanceof IngestError || error instanceof ConfigError
        ? error.message
        : "ingest steps failed with an unexpected error",
    );
    process.exitCode = 1;
  },
);
