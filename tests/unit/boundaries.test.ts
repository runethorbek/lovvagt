/**
 * Architecture boundaries: only the configuration module may read the
 * process environment, only the blob helper may name the blob variables,
 * and only the model adapter may import the Gemini SDK. See ADR 0003,
 * ADR 0004 and CLAUDE.md.
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

/** The only places allowed to name the blob variables. */
const blobModule = "lib/blob/";
const blobTestFiles = ["tests/unit/blob.test.ts"];

// Built at runtime so that this file's own source does not match the scan.
const blobVariables = [
  ["BLOB", "STORE", "ID"],
  ["DEV", "BLOB", "STORE", "ID"],
  ["VERCEL", "OIDC", "TOKEN"],
  ["BLOB", "READ", "WRITE", "TOKEN"],
  ["DEV", "BLOB", "READ", "WRITE", "TOKEN"],
].map((parts) => parts.join("_"));

// Whole-identifier matches: the production store ID name is a substring of the
// development one, which must be reported only as the longer name.
const blobVariablePatterns = blobVariables.map(
  (name) =>
    [name, new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`)] as const,
);

/** The only places allowed to import the Gemini SDK. */
const modelModule = "lib/model.ts";
const modelTestFiles = ["tests/unit/model.test.ts"];

// Matches a module specifier for the Gemini SDK (and the legacy SDK) in any
// import, export-from, dynamic import, require or vi.mock call. Built at
// runtime so that this file's own source does not match the scan.
const geminiPackages = [
  ["@google", "genai"],
  ["@google", "generative-ai"],
].map((parts) => parts.join("/"));
const geminiImport = new RegExp(
  `["'\`](${geminiPackages.join("|")})(/[^"'\`]*)?["'\`]`,
);

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

/** Returns `file: NAME, NAME` for each file outside the blob helper that names a blob variable. */
function findBlobViolations(root: string): string[] {
  const allowed = new Set(blobTestFiles);
  return sourceFiles(root)
    .filter((file) => !file.startsWith(blobModule) && !allowed.has(file))
    .flatMap((file) => {
      const content = readFileSync(join(root, file), "utf8");
      const names = blobVariablePatterns
        .filter(([, pattern]) => pattern.test(content))
        .map(([name]) => name);
      return names.length > 0 ? [`${file}: ${names.join(", ")}`] : [];
    })
    .sort();
}

/** Returns the repo-relative paths of files outside the model adapter that import the Gemini SDK. */
function findGeminiViolations(root: string): string[] {
  const allowed = new Set([modelModule, ...modelTestFiles]);
  return sourceFiles(root)
    .filter((file) => !allowed.has(file))
    .filter((file) => geminiImport.test(readFileSync(join(root, file), "utf8")))
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

describe("blob variable boundary", () => {
  it("names the blob variables only in the blob helper and its tests", () => {
    expect(findBlobViolations(repoRoot)).toEqual([]);
  });

  it("covers all five variable names", () => {
    expect(blobVariables).toHaveLength(5);
    expect(new Set(blobVariables).size).toBe(5);
  });

  it("scans the blob helper and its test file", () => {
    const files = sourceFiles(repoRoot);
    expect(files).toContain("lib/blob/config.ts");
    for (const file of blobTestFiles) expect(files).toContain(file);
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

    it("fails on each variable name outside the blob helper", () => {
      const [storeId, devStoreId, oidc, readWrite, devReadWrite] =
        blobVariables;
      fixture = mkdtempSync(join(tmpdir(), "lovvagt-boundaries-"));
      write("lib/blob/config.ts", `const a = "${storeId}";`);
      write("lib/blob/other.ts", `const a = "${devReadWrite}";`);
      write("tests/unit/blob.test.ts", `const a = "${oidc}";`);
      write("lib/a.ts", `const a = "${storeId}";`);
      write("lib/b.ts", `const b = "${devStoreId}";`);
      write("lib/c.ts", `const c = "${oidc}";`);
      write("lib/d.ts", `const d = "${readWrite}";`);
      write("app/e.tsx", `const e = "${devReadWrite}";`);
      write("lib/f.ts", `const f = ["${storeId}", "${devStoreId}"];`);
      write("lib/ok.ts", `const ok = "MY_${storeId}_X";`);
      write("tests/unit/other.test.ts", `const t = "${oidc}";`);
      write("node_modules/dep/index.js", `"${readWrite}";`);
      write("README.md", `${storeId}`);

      expect(findBlobViolations(fixture)).toEqual([
        `app/e.tsx: ${devReadWrite}`,
        `lib/a.ts: ${storeId}`,
        `lib/b.ts: ${devStoreId}`,
        `lib/c.ts: ${oidc}`,
        `lib/d.ts: ${readWrite}`,
        `lib/f.ts: ${storeId}, ${devStoreId}`,
        `tests/unit/other.test.ts: ${oidc}`,
      ]);
    });
  });
});

describe("Gemini SDK boundary", () => {
  it("is imported only by the model adapter and its tests", () => {
    expect(findGeminiViolations(repoRoot)).toEqual([]);
  });

  it("scans the model adapter and its test file", () => {
    const files = sourceFiles(repoRoot);
    expect(files).toContain(modelModule);
    for (const file of modelTestFiles) expect(files).toContain(file);
  });

  it("is actually imported by the model adapter", () => {
    const source = readFileSync(join(repoRoot, modelModule), "utf8");
    expect(geminiImport.test(source)).toBe(true);
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

    it("fails on each form of import outside the model adapter", () => {
      const [sdk, legacy] = geminiPackages;
      fixture = mkdtempSync(join(tmpdir(), "lovvagt-boundaries-"));
      write("lib/model.ts", `import { GoogleGenAI } from "${sdk}";`);
      write("tests/unit/model.test.ts", `vi.mock("${sdk}");`);
      write("lib/a.ts", `import { GoogleGenAI } from "${sdk}";`);
      write("lib/b.ts", `export { ApiError } from '${sdk}';`);
      write("lib/c.ts", `const m = await import(\`${sdk}/node\`);`);
      write("lib/d.cjs", `const m = require("${legacy}");`);
      write("app/e.tsx", `import type { Model } from "${sdk}";`);
      write("tests/unit/other.test.ts", `vi.mock("${sdk}");`);
      write("lib/ok.ts", `import { x } from "${sdk}-extra"; // ${sdk}`);
      write("node_modules/dep/index.js", `require("${sdk}");`);
      write("README.md", `"${sdk}"`);

      expect(findGeminiViolations(fixture)).toEqual([
        "app/e.tsx",
        "lib/a.ts",
        "lib/b.ts",
        "lib/c.ts",
        "lib/d.cjs",
        "tests/unit/other.test.ts",
      ]);
    });
  });
});
