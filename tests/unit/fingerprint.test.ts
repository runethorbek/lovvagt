import { describe, expect, it } from "vitest";
import { fingerprint } from "@/lib/fingerprint";

describe("fingerprint", () => {
  it("returns the first 8 hex characters of the SHA-256 hash", () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(fingerprint("abc")).toBe("ba7816bf");
  });

  it("returns 8 lowercase hex characters", () => {
    expect(fingerprint("Some-Host.Example")).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic and distinguishes inputs", () => {
    expect(fingerprint("host/db")).toBe(fingerprint("host/db"));
    expect(fingerprint("host/db")).not.toBe(fingerprint("host/db2"));
  });
});
