-- 0001: first schema for spec 002 (ingest from ODA). See ADR 0006.
--
-- ODA mirror tables: the primary key is the ODA id, columns are snake_case
-- ASCII versions of ODA's field names (aktørid -> aktoerid), and `raw` keeps
-- the full source record so later phases can read fields not mapped here.
-- ODA timestamps carry no offset; ingest converts them from Danish local
-- time before storing them as timestamptz. Lookup names (Sagstrinstype,
-- Stemmetype, SagAktørRolle, Dokumenttype, SagDokumentRolle) are copied
-- into `type` or `rolle` next to their id.
--
-- There are no foreign keys between mirror tables: ODA is the source of
-- truth and ingest stores rows in entity order, not reference order. Lovvagt's
-- own tables do reference the mirror rows they describe.

CREATE TABLE periode (
  id integer PRIMARY KEY,
  type text,
  kode text,
  titel text,
  startdato timestamptz NOT NULL,
  slutdato timestamptz NOT NULL,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

-- Candidate bills only (see tracked_sag).
CREATE TABLE sag (
  id integer PRIMARY KEY,
  typeid integer NOT NULL,
  kategoriid integer,
  statusid integer NOT NULL,
  periodeid integer NOT NULL,
  titel text,
  titelkort text,
  nummer text,
  nummerprefix text,
  nummernumerisk text,
  nummerpostfix text,
  resume text,
  afstemningskonklusion text,
  afgoerelse text,
  afgoerelsesdato timestamptz,
  afgoerelsesresultatkode text,
  lovnummer text,
  lovnummerdato timestamptz,
  retsinformationsurl text,
  fremsatundersagid integer,
  deltundersagid integer,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE INDEX sag_periodeid_idx ON sag (periodeid);

CREATE TABLE sagstrin (
  id integer PRIMARY KEY,
  sagid integer NOT NULL,
  typeid integer NOT NULL,
  type text,
  statusid integer NOT NULL,
  titel text,
  dato timestamptz,
  folketingstidende text,
  folketingstidendeurl text,
  folketingstidendesidenummer text,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE INDEX sagstrin_sagid_idx ON sagstrin (sagid);

CREATE TABLE afstemning (
  id integer PRIMARY KEY,
  sagstrinid integer,
  nummer integer NOT NULL,
  typeid integer NOT NULL,
  vedtaget boolean NOT NULL,
  konklusion text,
  kommentar text,
  moedeid integer NOT NULL,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE INDEX afstemning_sagstrinid_idx ON afstemning (sagstrinid);

CREATE TABLE stemme (
  id integer PRIMARY KEY,
  afstemningid integer NOT NULL,
  aktoerid integer NOT NULL,
  typeid integer,
  type text,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE INDEX stemme_afstemningid_idx ON stemme (afstemningid);
CREATE INDEX stemme_aktoerid_idx ON stemme (aktoerid);

-- Actors referenced by any stored row (ministries, MPs, committees, parties).
CREATE TABLE aktoer (
  id integer PRIMARY KEY,
  typeid integer NOT NULL,
  navn text,
  fornavn text,
  efternavn text,
  gruppenavnkort text,
  periodeid integer,
  startdato timestamptz,
  slutdato timestamptz,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE TABLE sag_aktoer (
  id integer PRIMARY KEY,
  sagid integer NOT NULL,
  aktoerid integer NOT NULL,
  rolleid integer NOT NULL,
  rolle text,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE INDEX sag_aktoer_sagid_idx ON sag_aktoer (sagid);
CREATE INDEX sag_aktoer_aktoerid_idx ON sag_aktoer (aktoerid);

CREATE TABLE dokument (
  id integer PRIMARY KEY,
  typeid integer NOT NULL,
  type text,
  kategoriid integer NOT NULL,
  statusid integer NOT NULL,
  titel text,
  dato timestamptz NOT NULL,
  modtagelsesdato timestamptz,
  frigivelsesdato timestamptz,
  offentlighedskode text,
  procedurenummer text,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE INDEX dokument_typeid_idx ON dokument (typeid);

CREATE TABLE sag_dokument (
  id integer PRIMARY KEY,
  sagid integer NOT NULL,
  dokumentid integer NOT NULL,
  rolleid integer NOT NULL,
  rolle text,
  bilagsnummer text,
  frigivelsesdato timestamptz,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE INDEX sag_dokument_sagid_idx ON sag_dokument (sagid);
CREATE INDEX sag_dokument_dokumentid_idx ON sag_dokument (dokumentid);

CREATE TABLE fil (
  id integer PRIMARY KEY,
  dokumentid integer NOT NULL,
  titel text,
  versionsdato timestamptz NOT NULL,
  filurl text,
  format text,
  variantkode text,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE INDEX fil_dokumentid_idx ON fil (dokumentid);

CREATE TABLE emneord (
  id integer PRIMARY KEY,
  typeid integer NOT NULL,
  emneord text,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE TABLE emneord_sag (
  id integer PRIMARY KEY,
  emneordid integer NOT NULL,
  sagid integer NOT NULL,
  opdateringsdato timestamptz NOT NULL,
  raw jsonb NOT NULL
);

CREATE INDEX emneord_sag_sagid_idx ON emneord_sag (sagid);

-- Lovvagt's own tables.

-- One row per candidate bill and topic. A bill that stops matching keeps its
-- row with matching = false. matched_rules is an array of
-- { kind, value, field } objects (spec 002, deliverable 3).
CREATE TABLE tracked_sag (
  sag_id integer NOT NULL REFERENCES sag (id),
  topic text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_]*$'),
  matched_rules jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(matched_rules) = 'array'),
  first_matched_at timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  matching boolean NOT NULL,
  PRIMARY KEY (sag_id, topic)
);

CREATE INDEX tracked_sag_topic_idx ON tracked_sag (topic) WHERE matching;

-- One row per stored file version. The same fil_id and sha256 is never
-- uploaded twice.
CREATE TABLE fil_blob (
  fil_id integer NOT NULL REFERENCES fil (id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  blob_path text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_type text NOT NULL,
  oda_opdateringsdato timestamptz NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fil_id, sha256)
);

-- One row per Blob advanced operation made by Lovvagt, for the monthly budget.
CREATE TABLE blob_op (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  op text NOT NULL CHECK (op IN ('put', 'copy', 'list')),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX blob_op_at_idx ON blob_op (at);

-- One row per POST /api/ingest call. A row with status 'running' is the
-- lease; lease_expires_at says when another call may take over. error holds
-- fixed strings only, never driver or API messages.
CREATE TABLE ingest_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL
    CHECK (status IN ('running', 'completed', 'stopped', 'failed', 'expired')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  lease_expires_at timestamptz NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  watermarks jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);

-- At most one running row, enforced by the database: a second lease fails
-- with a unique violation even when two calls race. An expired lease must be
-- marked 'expired' before a new one is taken.
CREATE UNIQUE INDEX ingest_run_one_running_idx ON ingest_run ((true))
  WHERE status = 'running';

CREATE INDEX ingest_run_started_at_idx ON ingest_run (started_at);
