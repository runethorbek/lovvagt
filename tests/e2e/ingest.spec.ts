import { expect, test } from "@playwright/test";

// CI has no secrets, so this exercises the fail-closed path: authorisation is
// checked before any database access.
test("POST /api/ingest without authorisation returns 401", async ({
  request,
}) => {
  const response = await request.post("/api/ingest");
  expect(response.status()).toBe(401);
  expect(await response.text()).toBe("");
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("POST /api/ingest with a wrong secret returns 401", async ({
  request,
}) => {
  const response = await request.post("/api/ingest", {
    headers: { authorization: "Bearer not-the-secret" },
  });
  expect(response.status()).toBe(401);
});

test("GET /api/ingest does not run ingest", async ({ request }) => {
  const response = await request.get("/api/ingest");
  expect(response.status()).toBe(405);
});
