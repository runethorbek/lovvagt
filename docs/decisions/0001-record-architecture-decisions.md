# 0001. Record architecture decisions

**Status:** Accepted
**Date:** 2026-11-15

## Context

Lovvagt is built largely by AI agents that start each task without memory of
earlier work. Decisions made in chats, pull request threads or a human's head
are invisible to them, so agents may re-open settled questions or silently
contradict them. Humans reviewing the work also need to know why things are
the way they are.

## Decision

Record every significant architecture decision as a short Markdown file in
`docs/decisions/`.

- File name: `NNNN-short-title.md`, numbered sequentially from `0001`.
- Sections: **Context** (the forces and constraints), **Decision** (what we
  do, stated actively), **Consequences** (what becomes easier, harder or
  required as a result).
- Header fields: **Status** (Proposed, Accepted, Superseded by NNNN) and
  **Date**.
- A decision is never edited to mean something else. To change it, add a new
  record and mark the old one as superseded.
- An agent that makes or proposes an architecture decision adds a record in
  the same pull request.

"Significant" means it affects structure, dependencies, data model,
infrastructure, external services or cross-cutting conventions.

## Consequences

- Agents and humans can learn why the system looks the way it does from the
  repository alone.
- Decisions get reviewed in pull requests like code.
- There is a small overhead per decision, kept low by the short format.
