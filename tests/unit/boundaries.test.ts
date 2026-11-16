/**
 * Architecture boundaries: only the configuration module may read the
 * process environment. See ADR 0003 and CLAUDE.md.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

/** The only file allowed to read the process environment. */
const configModule = "lib/config.ts";

/** Framework-required files that must read the environment themselves. */
const allowList = ["playwright.config.ts"];

const sourceExtensions = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vercel",
  "out",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
]);

// Matches dot and bracket access to the env property of `process`. Written as
// a regex so that this file does not match itself.
const environmentAccess = /\bprocess\s*(\.\s*env\b|\[\s*["'`]env["'`]\s*\])/;

function sourceFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name))
        files.push(...sourceFiles(root, path));
    } else if (sourceExtensions.test(entry.name)) {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files;
}

/** Returns the repo-relative paths of files that read the environment but may not. */
function findViolations(root: string): string[] {
  const allowed = new Set([configModule, ...allowList]);
  return sourceFiles(root)
    .filter((file) => !allowed.has(file))
    .filter((file) =>
      environmentAccess.test(readFileSync(join(root, file), "utf8")),
    )
    .sort();
}

describe("process environment boundary", () => {
  it("is read only by the configuration module and allow-listed files", () => {
    expect(findViolations(repoRoot)).toEqual([]);
  });

  it("scans the configuration module itself", () => {
    expect(sourceFiles(repoRoot)).toContain(configModule);
  });

  describe("on a fixture repository", () => {
    let fixture: string;

    afterEach(() => {
      rmSync(fixture, { recursive: true, force: true });
    });

    function write(path: string, content: string) {
      const full = join(fixture, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }

    // Built at runtime so this file's own source does not match the scan.
    const env = ["process", "env"].join(".");

    it("fails on a disallowed use", () => {
      fixture = mkdtempSync(join(tmpdir(), "lovvagt-boundaries-"));
      write("lib/config.ts", `export const a = ${env}.A;`);
      write("playwright.config.ts", `export const ci = ${env}.CI;`);
      write("lib/ok.ts", "export const ok = 1;");
      write("lib/bad.ts", `export const key = ${env}.GEMINI_API_KEY;`);
      write("app/api/bad.tsx", `const e = ${["process", '["env"]'].join("")};`);
      write("node_modules/dep/index.js", `${env}.X;`);

      expect(findViolations(fixture)).toEqual([
        "app/api/bad.tsx",
        "lib/bad.ts",
      ]);
    });
  });
});
