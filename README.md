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
