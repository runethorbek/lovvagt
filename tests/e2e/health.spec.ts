import { expect, test } from "@playwright/test";

// CI has no secrets, so this exercises the fail-closed path as well.
test("GET /api/health without authorisation returns 401", async ({
  request,
}) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(401);
  expect(await response.text()).toBe("");
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("GET /api/health with a wrong secret returns 401", async ({ request }) => {
  const response = await request.get("/api/health", {
    headers: { authorization: "Bearer not-the-secret" },
  });
  expect(response.status()).toBe(401);
});
