/**
 * `npx tsx --env-file-if-exists=.env.local scripts/ingest-until-done.ts <baseUrl>`
 *
 * Calls `POST <baseUrl>/api/ingest` until the response says `"done": true`,
 * for local and manual backfills (spec 002, deliverable 5; see
 * `docs/ingest.md`). Prints one summary line per call and the full response
 * of the last one. Reads `CRON_SECRET` through `lib/config.ts` and never
 * prints it or the request headers.
 *
 * Exits 0 when a call reports `done: true`; 1 on 401, 409, 500, any other
 * unexpected status, a response that is not JSON, a network error or too
 * many calls; 2 on a usage or configuration error. Not run in CI.
 */
import { ConfigError, config } from "@/lib/config";

/** Stop after this many calls, in case a run never finishes. */
const maxCalls = 200;

/** Longer than the route's 300 s maximum duration. */
const callTimeoutMs = 330_000;

type Counts = {
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
};

type Report = {
  runId?: number | null;
  done?: boolean;
  counts?: Record<string, Counts>;
  files?: Record<string, number>;
  blobOperationsThisMonth?: number | null;
  error?: string;
};

function summary(call: number, status: number, report: Report): string {
  const totals = Object.values(report.counts ?? {}).reduce(
    (sum, counts) => ({
      fetched: sum.fetched + counts.fetched,
      inserted: sum.inserted + counts.inserted,
      updated: sum.updated + counts.updated,
    }),
    { fetched: 0, inserted: 0, updated: 0 },
  );
  return [
    `call ${call}: HTTP ${status}`,
    `run ${report.runId ?? "-"}`,
    `done ${report.done === true}`,
    `fetched ${totals.fetched}, inserted ${totals.inserted}, updated ${totals.updated}`,
    `blob ops this month ${report.blobOperationsThisMonth ?? "-"}`,
    ...(report.error === undefined ? [] : [`error "${report.error}"`]),
  ].join("; ");
}

async function main(): Promise<number> {
  const [baseUrl, ...rest] = process.argv.slice(2);
  let endpoint: URL;
  try {
    if (baseUrl === undefined || rest.length > 0) throw new Error("usage");
    endpoint = new URL("/api/ingest", baseUrl);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
      throw new Error("usage");
  } catch {
    console.error(
      "usage: npx tsx --env-file-if-exists=.env.local scripts/ingest-until-done.ts <baseUrl>",
    );
    return 2;
  }

  let secret: string;
  try {
    secret = config.cronSecret();
  } catch (error) {
    console.error(
      error instanceof ConfigError ? error.message : "configuration error",
    );
    return 2;
  }

  console.log(`Calling POST ${endpoint.href} until done`);
  for (let call = 1; call <= maxCalls; call += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(callTimeoutMs),
      });
    } catch {
      console.error(`call ${call}: request failed (network error or timeout)`);
      return 1;
    }

    if (response.status === 401) {
      console.error(`call ${call}: HTTP 401 (wrong or missing CRON_SECRET)`);
      return 1;
    }
    let report: Report;
    try {
      report = (await response.json()) as Report;
    } catch {
      console.error(`call ${call}: HTTP ${response.status}, not JSON`);
      return 1;
    }
    console.log(summary(call, response.status, report));
    if (response.status !== 200) return 1;
    if (report.done === true) {
      console.log("Last response:");
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
  }
  console.error(`not done after ${maxCalls} calls`);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error("ingest-until-done failed with an unexpected error");
    process.exitCode = 1;
  },
);
