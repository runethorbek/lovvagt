import { describe, expect, it } from "vitest";
import { site } from "@/lib/site";

describe("site", () => {
  it("has a name and a description", () => {
    expect(site.name).toBe("Lovvagt");
    expect(site.description.length).toBeGreaterThan(0);
  });
});
