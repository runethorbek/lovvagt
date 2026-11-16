# 0002. Stack and infrastructure

**Status:** Accepted (the blob token part of decision 4 is superseded by 0004)
**Date:** 2026-11-15

## Context

Lovvagt is a proof of concept that tracks Danish parliamentary bills on AI,
security and defence, using data from Folketingets Åbne Data (ODA). It runs a
daily pipeline (ingest, transform, enrich, review, events) and presents the
results in a dashboard. It is built mostly by AI agents, run by one person, and
should cost close to nothing while it proves its value. Data and processing
should stay in the EU where possible.

## Decision

1. **Application:** Next.js and TypeScript on Vercel, on the Hobby plan for
   the proof of concept.
2. **Scheduling and orchestration:** a daily Vercel Cron job triggers a Vercel
   Workflow that runs the pipeline. Each stage, and each review, is a separate
   durable step, so a failure can be retried without redoing earlier work.
3. **Database:** Neon Postgres in Frankfurt stores metadata, extracted text and
   events.
4. **Document storage:** original documents are stored in Vercel Blob, with
   separate stores for production (`lovvagt-docs`) and development/preview
   (`lovvagt-docs-dev`). Code accesses Blob only through one helper that picks
   the token from `VERCEL_ENV`.
5. **LLM:** Gemini on the free tier, with separate Google projects (and keys)
   for production and development. All calls go through a model adapter so
   the model can be chosen or swapped per task.
6. **Agentic review:** every enrichment is checked by three independent
   reviewers: faithfulness, completeness and neutrality. A deterministic
   decision rule combines their verdicts. Only when the reviewers disagree is
   the case escalated to a stronger judge model.
7. **Language:** code, comments and docs are in English; ODA domain terms
   (Sag, Sagstrin, Aktør, ...) keep their Danish names to mirror the ODA data
   model.

## Consequences

- One platform (Vercel) covers hosting, scheduling, workflows and storage,
  which keeps operations simple; the cost is vendor lock-in and Hobby plan
  limits (cron frequency, function duration), which must be respected.
- Durable steps make the pipeline restartable and observable per stage and per
  review.
- Separate stores, keys and projects per environment prevent development work
  from touching production data or quota.
- The Gemini free tier has rate limits and may use data for training; only
  public parliamentary data is sent. The adapter makes moving to a paid tier or
  another provider a local change.
- Three reviewers plus escalation costs more calls than a single check, but
  gives traceable, reproducible quality decisions; the deterministic rule keeps
  outcomes explainable.
- Danish terms in code require the glossary in `CLAUDE.md` for non-Danish
  readers.
