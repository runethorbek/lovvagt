# Lovvagt

Lovvagt ("law watch") follows bills in the Danish Parliament (Folketinget)
within selected topics — currently AI, security and defence — and shows
how many there are, where they are in the legislative process, and who
they affect.

## Why

A proof of concept for building a product largely through orchestrated
AI agents: from idea and specification to implementation, testing and
deployment, with humans setting direction and reviewing outcomes.

## How it works

1. **Ingest** – fetches cases, stages, votes and documents from
   Folketingets Åbne Data (oda.ft.dk)
2. **Transform** – extracts text and tracks document versions
3. **Enrich** – classifies topics and summarises bills with source references
4. **Review** – independent review agents check faithfulness,
   completeness and neutrality before anything is published
5. **Events** – detects stage changes and builds timelines
6. **Dashboard** – shows tracked bills, timelines and who is affected

## Status

Early proof of concept. Not legal advice.

## Data

Data from Folketingets Åbne Data. Summaries are AI-generated and may
contain errors; always consult the source documents.

## Claude Code skills

Shared Claude Code skills, and the subagents they depend on, are copied from
the central repository `runethorbek/skills` into `.claude/skills/` and
`.claude/agents/`. `runethorbek/skills` is the source of truth: do not edit
the synchronized copies here. Change them there and synchronize again.

| Skill          | Use                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/draft-issue` | Turn an idea into an idea-stage issue draft grounded in the repository                                                                       |
| `/agent-ready` | Turn an issue into one small slice an agent can implement                                                                                    |
| `/build-slice` | Implement one slice: a `slice-implementer` subagent builds, a fresh read-only `slice-reviewer` subagent reviews each round, bounded fix loop |

| File                                       | Purpose                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `.github/workflows/sync-claude-skills.yml` | Manually triggered workflow that synchronizes and opens a pull request                  |
| `.github/scripts/sync-claude-skills.sh`    | Copies the selected skills and agents; never runs anything from the source repository   |
| `.github/claude-skills.txt`                | Which skills and agents to synchronize                                                  |
| `.claude/skills-sync-manifest.txt`         | Generated: source repository, source commit SHA, and the synchronized skills and agents |
| `tests/unit/sync-claude-skills.test.ts`    | Unit tests for the sync script                                                          |

The synchronized files are excluded from Prettier (`.prettierignore`), because
their formatting is owned by the source repository.

### Trigger a synchronization

GitHub → **Actions** → **Sync Claude Code skills** → **Run workflow**.
Optionally enter a branch, tag, or commit SHA of `runethorbek/skills`
(default `main`). The workflow:

- opens a pull request from the `automation/sync-claude-skills` branch, or
  updates the one that is already open;
- does nothing if the selected skills and agents already match;
- fails without changing anything if a selected skill or agent does not
  exist in the source, contains a symlink, or would overwrite a
  project-specific skill or agent of the same name.

Pull requests created by GitHub Actions do not start the `ci` check
automatically. Close and reopen the pull request to run it.

Repository settings this needs once:

- **Settings → Actions → General → Workflow permissions**: enable
  **Allow GitHub Actions to create and approve pull requests**.
- Only if `runethorbek/skills` becomes private: a repository secret
  `SKILLS_SOURCE_TOKEN` with a fine-grained token that has read-only
  **Contents** access to `runethorbek/skills`.

### Configure the selection

Edit `.github/claude-skills.txt`, one entry per line: `<name>` selects the
skill `claude/skills/<name>/`, `agent:<name>` the agent
`claude/agents/<name>.md`. Select the agents a skill depends on with it:
`build-slice` needs `agent:slice-implementer` and `agent:slice-reviewer`.
An entry removed from the list is deleted from `.claude/` by the next
synchronization. Skills and agents that were never synchronized are never
touched.

### Remove the integration

Delete the files in the table above, the synchronized skills
and agents listed in the manifest, and the `.prettierignore` entries in one
pull request. Then delete the `automation/sync-claude-skills` branch.
