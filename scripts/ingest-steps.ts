/**
 * `npx tsx --env-file-if-exists=.env.local scripts/ingest-steps.ts`
 *
 * Runs ingest steps 1 and 2 (sessions and candidate bills,
 * `lib/ingest/steps.ts`) to completion against the database named by
 * `DATABASE_URL` and live ODA, then prints the counts, the candidate count
 * per topic and whether the known 2024-25 bills are tracked as expected.
 *
 * Refuses to run unless the environment is `development`. Starts from the
 * stored `sag` watermark if there is one, and stores none: the run lease and
 * watermark bookkeeping belong to `POST /api/ingest`. Prints no connection
 * details and no driver or ODA error messages. Not run in CI.
 */
import { ConfigError, config } from "@/lib/config";
import { executor } from "@/lib/db";
import { readWatermark } from "@/lib/ingest/repository";
import {
  type Counts,
  IngestError,
  ingestBills,
  ingestSessions,
} from "@/lib/ingest/steps";
import { topicRules } from "@/lib/ingest/topics";

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

  const since = await readWatermark(sql, "sag");
  console.log(`Bills since: ${since?.toISOString() ?? "(first run)"}`);
  let result = await ingestBills(sql, { since });
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
    if (result.done) break;
    result = await ingestBills(sql, { cursor: result.cursor });
    calls += 1;
  }
  console.log(`Bills (${calls} call(s)):`);
  printCounts(total);
  console.log(
    `New sag watermark (not stored): ${result.watermark?.toISOString() ?? "none"}`,
  );

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
  return ok ? 0 : 1;
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
