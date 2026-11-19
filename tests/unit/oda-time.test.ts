import { describe, expect, it } from "vitest";
import { parseOdaTimestamp, tryParseOdaTimestamp } from "@/lib/oda";

const utc = (text: string) => parseOdaTimestamp(text).toISOString();

describe("parseOdaTimestamp", () => {
  it("reads summer time as UTC+2", () => {
    expect(utc("2026-07-01T12:00:00")).toBe("2026-07-01T10:00:00.000Z");
  });

  it("reads winter time as UTC+1, with fractional seconds", () => {
    expect(utc("2026-11-18T14:31:51.75")).toBe("2026-11-18T13:31:51.750Z");
  });

  it.each([
    ["2025-07-25T12:35:04.057", "2025-07-25T10:35:04.057Z"],
    ["2025-05-08T10:01:20.4", "2025-05-08T08:01:20.400Z"],
    ["2026-01-01T00:00:00", "2025-12-31T23:00:00.000Z"],
    ["2024-09-30T13:08:47.483", "2024-09-30T11:08:47.483Z"],
    // Seven fractional digits (.NET precision): milliseconds are truncated.
    ["2026-11-18T14:31:51.1234567", "2026-11-18T13:31:51.123Z"],
  ])("converts %s", (text, expected) => {
    expect(utc(text)).toBe(expected);
  });

  describe("around the spring transition (2026-03-29, 02:00 -> 03:00)", () => {
    it.each([
      ["2026-03-29T01:59:59", "2026-03-29T00:59:59.000Z"],
      ["2026-03-29T03:00:00", "2026-03-29T01:00:00.000Z"],
    ])("converts %s", (text, expected) => {
      expect(utc(text)).toBe(expected);
    });

    it("reads a nonexistent time with the winter offset", () => {
      expect(utc("2026-03-29T02:30:00")).toBe("2026-03-29T01:30:00.000Z");
    });
  });

  describe("around the autumn transition (2026-10-25, 03:00 -> 02:00)", () => {
    it.each([
      ["2026-10-25T01:59:59", "2026-10-24T23:59:59.000Z"],
      ["2026-10-25T03:00:00", "2026-10-25T02:00:00.000Z"],
    ])("converts %s", (text, expected) => {
      expect(utc(text)).toBe(expected);
    });

    it("reads an ambiguous time as the earlier instant (summer time)", () => {
      expect(utc("2026-10-25T02:30:00")).toBe("2026-10-25T00:30:00.000Z");
    });
  });

  it.each([
    "2026-11-18T14:31:51Z",
    "2026-11-18T14:31:51+01:00",
    "2026-11-18",
    "2026-02-30T12:00:00",
    "2026-11-18T24:00:00",
    "2026-11-18T14:60:00",
    "",
  ])("rejects %j", (text) => {
    expect(tryParseOdaTimestamp(text)).toBeUndefined();
    expect(() => parseOdaTimestamp(text)).toThrow(
      new RangeError("invalid ODA timestamp"),
    );
  });
});
