import { expect, test } from "@playwright/test";

test("home page shows the Lovvagt heading", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Lovvagt" }),
  ).toBeVisible();
});
