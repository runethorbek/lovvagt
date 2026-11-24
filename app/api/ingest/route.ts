/**
 * `POST /api/ingest`: one call of the ingest run (spec 002, deliverable 5).
 * Requires `Authorization: Bearer <CRON_SECRET>`. Call it again until the
 * response says `"done": true`. See `docs/ingest.md` and `lib/ingest/run.ts`.
 */
import { databaseErrors, executor, type SqlExecutor } from "@/lib/db";
import { isAuthorised } from "@/lib/health";
import { emptyReport, runErrors, runIngest } from "@/lib/ingest/run";

// Never prerender or cache: every call must run.
export const dynamic = "force-dynamic";

// Seconds. The run's time budget (`defaultBudgetMs`) stays well below it.
export const maxDuration = 300;

const noStore = { "Cache-Control": "no-store" };

const httpStatus = { completed: 200, stopped: 200, busy: 409, failed: 500 };

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorised(request.headers.get("authorization"))) {
    // No body and no detail on why, and nothing runs: no ingest_run row.
    return new Response(null, {
      status: 401,
      headers: { ...noStore, "WWW-Authenticate": "Bearer" },
    });
  }

  let sql: SqlExecutor;
  try {
    sql = executor();
  } catch {
    return Response.json(emptyReport(databaseErrors.configuration), {
      status: 500,
      headers: noStore,
    });
  }

  try {
    const { status, report } = await runIngest(sql);
    return Response.json(report, {
      status: httpStatus[status],
      headers: noStore,
    });
  } catch {
    // `runIngest` does not throw; this guards against a bug leaking a message.
    return Response.json(emptyReport(runErrors.unexpected), {
      status: 500,
      headers: noStore,
    });
  }
}
