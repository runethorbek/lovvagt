/**
 * `GET /api/health`: protected health check for the database, blob store and
 * Gemini. Requires `Authorization: Bearer <CRON_SECRET>`. See
 * `docs/health-check.md`.
 */
import { isAuthorised, runHealthChecks } from "@/lib/health";

// Never prerender or cache: every call must run the checks.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorised(request.headers.get("authorization"))) {
    // No body and no detail on why: unauthorised callers learn nothing.
    return new Response(null, {
      status: 401,
      headers: { ...noStore, "WWW-Authenticate": "Bearer" },
    });
  }

  const report = await runHealthChecks();
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: noStore,
  });
}
