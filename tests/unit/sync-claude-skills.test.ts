/**
 * The skills sync script (.github/scripts/sync-claude-skills.sh) copies the
 * selected skills and agents from a checkout of runethorbek/skills into
 * .claude/ and records the source commit. These tests run it on temporary
 * fixtures.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const script = join(repoRoot, ".github", "scripts", "sync-claude-skills.sh");
const repository = "runethorbek/skills";
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

type Fixture = {
  source: string;
  config: string;
  claude: string;
  skills: string;
  agents: string;
  manifest: string;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sync-claude-skills-"));
  roots.push(root);
  const claude = join(root, "target", ".claude");
  return {
    source: join(root, "source"),
    config: join(root, "claude-skills.txt"),
    claude,
    skills: join(claude, "skills"),
    agents: join(claude, "agents"),
    manifest: join(claude, "skills-sync-manifest.txt"),
  };
}

function writeFile(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function writeSourceSkill(
  fixture: Fixture,
  name: string,
  files: Record<string, string>,
) {
  for (const [file, content] of Object.entries(files)) {
    writeFile(join(fixture.source, "claude", "skills", name, file), content);
  }
}

function writeSourceAgent(fixture: Fixture, name: string, content: string) {
  writeFile(join(fixture.source, "claude", "agents", `${name}.md`), content);
}

function sync(fixture: Fixture, commit = commitA) {
  return spawnSync(
    "bash",
    [
      script,
      fixture.source,
      repository,
      commit,
      fixture.config,
      fixture.claude,
      fixture.manifest,
    ],
    { encoding: "utf8" },
  );
}

function read(file: string) {
  return readFileSync(file, "utf8");
}

describe("sync-claude-skills.sh", () => {
  it("copies selected skills, records the source commit, and leaves other skills alone", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "agent-ready", {
      "SKILL.md": "agent-ready v1\n",
      "reference/notes.md": "notes\n",
    });
    writeSourceSkill(fixture, "draft-issue", {
      "SKILL.md": "draft-issue v1\n",
    });
    writeSourceSkill(fixture, "not-selected", { "SKILL.md": "not selected\n" });
    writeFile(
      fixture.config,
      "# comment\nagent-ready\n\n  draft-issue  # trailing comment\n",
    );
    writeFile(
      join(fixture.skills, "project-skill", "SKILL.md"),
      "project specific\n",
    );

    const result = sync(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(read(join(fixture.skills, "agent-ready", "SKILL.md"))).toBe(
      "agent-ready v1\n",
    );
    expect(
      read(join(fixture.skills, "agent-ready", "reference", "notes.md")),
    ).toBe("notes\n");
    expect(read(join(fixture.skills, "draft-issue", "SKILL.md"))).toBe(
      "draft-issue v1\n",
    );
    expect(existsSync(join(fixture.skills, "not-selected"))).toBe(false);
    expect(read(join(fixture.skills, "project-skill", "SKILL.md"))).toBe(
      "project specific\n",
    );
    expect(read(fixture.manifest)).toBe(
      [
        "# Managed by .github/workflows/sync-claude-skills.yml. Do not edit by hand.",
        `source=${repository}`,
        `commit=${commitA}`,
        "skill=agent-ready",
        "skill=draft-issue",
        "",
      ].join("\n"),
    );
  });

  it("changes nothing when re-run against unchanged skills, even for a newer source commit", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "agent-ready", {
      "SKILL.md": "agent-ready v1\n",
    });
    writeFile(fixture.config, "agent-ready\n");
    expect(sync(fixture, commitA).status).toBe(0);
    const manifestBefore = read(fixture.manifest);

    const result = sync(fixture, commitB);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/No changes/);
    expect(read(fixture.manifest)).toBe(manifestBefore);
  });

  it("updates changed files, removes files deleted in the source, and records the new commit", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "agent-ready", {
      "SKILL.md": "v1\n",
      "old.md": "obsolete\n",
    });
    writeFile(fixture.config, "agent-ready\n");
    expect(sync(fixture, commitA).status).toBe(0);

    rmSync(join(fixture.source, "claude", "skills", "agent-ready", "old.md"));
    writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "v2\n" });
    const result = sync(fixture, commitB);

    expect(result.status, result.stderr).toBe(0);
    expect(read(join(fixture.skills, "agent-ready", "SKILL.md"))).toBe("v2\n");
    expect(existsSync(join(fixture.skills, "agent-ready", "old.md"))).toBe(
      false,
    );
    expect(read(fixture.manifest)).toMatch(
      new RegExp(`^commit=${commitB}$`, "m"),
    );
  });

  it("removes a previously synchronized skill that is no longer selected", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready\n" });
    writeSourceSkill(fixture, "draft-issue", { "SKILL.md": "draft-issue\n" });
    writeFile(
      join(fixture.skills, "project-skill", "SKILL.md"),
      "project specific\n",
    );
    writeFile(fixture.config, "agent-ready\ndraft-issue\n");
    expect(sync(fixture).status).toBe(0);

    writeFile(fixture.config, "agent-ready\n");
    const result = sync(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(fixture.skills, "draft-issue"))).toBe(false);
    expect(existsSync(join(fixture.skills, "agent-ready", "SKILL.md"))).toBe(
      true,
    );
    expect(read(join(fixture.skills, "project-skill", "SKILL.md"))).toBe(
      "project specific\n",
    );
    expect(read(fixture.manifest)).not.toMatch(/skill=draft-issue/);
  });

  it("fails without changing anything when a selected skill is missing from the source", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready\n" });
    writeFile(fixture.config, "agent-ready\nridge\n");

    const result = sync(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /skill not found in runethorbek\/skills: claude\/skills\/ridge/,
    );
    expect(existsSync(fixture.skills)).toBe(false);
    expect(existsSync(fixture.manifest)).toBe(false);
  });

  it("refuses to overwrite a project-specific skill with the same name", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "from source\n" });
    writeFile(
      join(fixture.skills, "agent-ready", "SKILL.md"),
      "project specific\n",
    );
    writeFile(fixture.config, "agent-ready\n");

    const result = sync(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not managed by this sync/);
    expect(read(join(fixture.skills, "agent-ready", "SKILL.md"))).toBe(
      "project specific\n",
    );
    expect(existsSync(fixture.manifest)).toBe(false);
  });

  it("rejects skills that contain symlinks", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready\n" });
    symlinkSync(
      "/etc/passwd",
      join(fixture.source, "claude", "skills", "agent-ready", "link"),
    );
    writeFile(fixture.config, "agent-ready\n");

    const result = sync(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink/);
    expect(existsSync(fixture.skills)).toBe(false);
  });

  it("rejects skill names that could escape the skills directory", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.source, "claude", "skills"), { recursive: true });
    writeFile(fixture.config, "../outside\n");

    const result = sync(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/invalid name/);
  });

  it("rejects a source commit that is not a full SHA", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "agent-ready", { "SKILL.md": "agent-ready\n" });
    writeFile(fixture.config, "agent-ready\n");

    const result = sync(fixture, "main");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/full 40-character SHA/);
  });

  it("copies selected agents, removes deselected ones, and leaves project agents alone", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "build-slice", { "SKILL.md": "build-slice\n" });
    writeSourceAgent(fixture, "slice-implementer", "implementer v1\n");
    writeSourceAgent(fixture, "slice-reviewer", "reviewer v1\n");
    writeSourceAgent(fixture, "not-selected", "not selected\n");
    writeFile(join(fixture.agents, "project-agent.md"), "project specific\n");
    writeFile(
      fixture.config,
      "build-slice\nagent:slice-implementer\nagent:slice-reviewer\n",
    );

    const first = sync(fixture, commitA);

    expect(first.status, first.stderr).toBe(0);
    expect(read(join(fixture.agents, "slice-implementer.md"))).toBe(
      "implementer v1\n",
    );
    expect(read(join(fixture.agents, "slice-reviewer.md"))).toBe(
      "reviewer v1\n",
    );
    expect(existsSync(join(fixture.agents, "not-selected.md"))).toBe(false);
    expect(read(fixture.manifest)).toMatch(/^agent=slice-implementer$/m);
    expect(read(fixture.manifest)).toMatch(/^agent=slice-reviewer$/m);

    const rerun = sync(fixture, commitB);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(rerun.stdout).toMatch(/No changes/);

    writeSourceAgent(fixture, "slice-implementer", "implementer v2\n");
    writeFile(fixture.config, "build-slice\nagent:slice-implementer\n");
    const updated = sync(fixture, commitB);

    expect(updated.status, updated.stderr).toBe(0);
    expect(read(join(fixture.agents, "slice-implementer.md"))).toBe(
      "implementer v2\n",
    );
    expect(existsSync(join(fixture.agents, "slice-reviewer.md"))).toBe(false);
    expect(read(join(fixture.agents, "project-agent.md"))).toBe(
      "project specific\n",
    );
    expect(read(fixture.manifest)).toMatch(
      new RegExp(`^commit=${commitB}$`, "m"),
    );
  });

  it("fails without changing anything when a selected agent is missing from the source", () => {
    const fixture = createFixture();
    writeSourceSkill(fixture, "build-slice", { "SKILL.md": "build-slice\n" });
    writeFile(fixture.config, "build-slice\nagent:slice-implementer\n");

    const result = sync(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /agent not found in runethorbek\/skills: claude\/agents\/slice-implementer.md/,
    );
    expect(existsSync(fixture.skills)).toBe(false);
    expect(existsSync(fixture.manifest)).toBe(false);
  });

  it("refuses to overwrite a project-specific agent with the same name", () => {
    const fixture = createFixture();
    writeSourceAgent(fixture, "slice-reviewer", "from source\n");
    writeFile(join(fixture.agents, "slice-reviewer.md"), "project specific\n");
    writeFile(fixture.config, "agent:slice-reviewer\n");

    const result = sync(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not managed by this sync/);
    expect(read(join(fixture.agents, "slice-reviewer.md"))).toBe(
      "project specific\n",
    );
  });
});
