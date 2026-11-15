# Specs

A spec describes a piece of work before it is built. It is written by a human
(possibly with help from an agent) and is the source for an epic and its
sub-issues.

## File naming

`NNN-short-title.md`, numbered sequentially, e.g. `001-ingest.md`.
`000-foundation.md` set up the repository itself.

## Structure

Every spec has these sections:

- **Goal**: what is true when the work is done, and why it matters.
- **Context**: what already exists, constraints, and links to relevant
  decisions in `docs/decisions/`.
- **Out of scope**: what this spec deliberately does not cover.
- **Deliverables**: the concrete things to build, specific enough that an
  agent can implement them without guessing intent.
- **Acceptance criteria**: a checklist of verifiable conditions. Each one
  must be checkable by a command, a test or an inspection.

Add a header with **Status** (Draft, Ready for implementation, Done) and
**Owner**.

## From spec to issues

1. When a spec is **Ready for implementation**, create an **Epic** issue from
   the epic template. Link the spec, copy the goal, and list the expected
   sub-issues and what is out of scope. Label it `type:epic` and the relevant
   `area:*`.
2. Split the deliverables into **Task** issues from the task template. Each
   task is small enough for one branch and one pull request, has its own
   acceptance criteria, and names its dependencies. Label each `type:task`
   and the relevant `area:*`.
3. Link each task from the epic's sub-issue list.
4. When a task is ready to work on (its dependencies are done and its intent
   is clear), label it `agent:ready`. Agents then follow the workflow rules
   in `CLAUDE.md`.
5. When all sub-issues are closed, close the epic and set the spec's status
   to **Done**.

If implementation shows the spec is wrong or incomplete, update the spec in a
pull request rather than drifting from it silently.
