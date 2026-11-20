/**
 * Typed queries for the ODA entity sets that ingest uses (spec 002,
 * deliverable 2). Rows are validated with Zod. Each result keeps the full
 * source row in `raw`, so fields not mapped here stay available.
 *
 * Typed fields use the ASCII names of the database columns (`aktørid`
 * becomes `aktoerid`, `mødeid` becomes `moedeid`); `raw` keeps ODA's names.
 * Timestamps are converted from Danish local time to UTC (`lib/oda/time.ts`).
 *
 * Navigation properties are only present when the query expands them, e.g.
 * `fetchSagstrin({ expand: "Sagstrinstype" })` fills `type`, and
 * `fetchSagDokument({ expand: "Dokument/Fil" })` fills `dokument.fil`. When
 * not expanded they are `null`.
 */
import { z } from "zod";
import {
  odaFetchAll,
  type OdaQuery,
  type OdaRequestOptions,
} from "@/lib/oda/client";
import { tryParseOdaTimestamp } from "@/lib/oda/time";

/** The full source row, as returned by ODA. */
export type OdaRaw = Record<string, unknown>;

const rawSchema = z.record(z.string(), z.unknown());

const id = z.number().int();
const text = z.string().nullable();
const timestamp = z.string().transform((value, ctx) => {
  const date = tryParseOdaTimestamp(value);
  if (date === undefined) {
    ctx.issues.push({
      code: "custom",
      message: "invalid timestamp",
      input: value,
    });
    return z.NEVER;
  }
  return date;
});
const optionalTimestamp = timestamp.nullable();

/**
 * Builds a row parser: validates the typed fields with `shape`, maps them
 * with `map`, and adds the whole source row as `raw`. Returns `undefined`
 * for an invalid row; validation details are discarded.
 */
function rowParser<S extends z.ZodRawShape, T>(
  shape: S,
  map: (row: z.output<z.ZodObject<S>>) => T,
): (row: unknown) => (T & { raw: OdaRaw }) | undefined {
  const typed = z.object(shape);
  return (row) => {
    const raw = rawSchema.safeParse(row);
    if (!raw.success) return undefined;
    const parsed = typed.safeParse(raw.data);
    if (!parsed.success) return undefined;
    return { ...map(parsed.data), raw: raw.data };
  };
}

/** A schema that runs a row parser, for expanded navigation properties. */
function nested<T>(parse: (row: unknown) => T | undefined) {
  return z.unknown().transform((value, ctx) => {
    const parsed = parse(value);
    if (parsed === undefined) {
      ctx.issues.push({ code: "custom", message: "invalid row", input: value });
      return z.NEVER;
    }
    return parsed;
  });
}

// Lookup tables: Sagstrinstype, Stemmetype, Dokumenttype (`type`) and
// SagAktørRolle, SagDokumentRolle (`rolle`).

const typeShape = { id, type: z.string(), opdateringsdato: timestamp };
const rolleShape = { id, rolle: z.string(), opdateringsdato: timestamp };
const parseType = rowParser(typeShape, (row) => row);
const parseRolle = rowParser(rolleShape, (row) => row);

export type OdaType = NonNullable<ReturnType<typeof parseType>>;
export type OdaRolle = NonNullable<ReturnType<typeof parseRolle>>;

// Periode

const parsePeriode = rowParser(
  {
    id,
    type: z.string(),
    kode: text,
    titel: text,
    startdato: timestamp,
    slutdato: timestamp,
    opdateringsdato: timestamp,
  },
  (row) => row,
);
export type Periode = NonNullable<ReturnType<typeof parsePeriode>>;

// Sag

const parseSag = rowParser(
  {
    id,
    typeid: id,
    kategoriid: id.nullable(),
    statusid: id,
    periodeid: id,
    titel: text,
    titelkort: text,
    nummer: text,
    nummerprefix: text,
    nummernumerisk: text,
    nummerpostfix: text,
    resume: text,
    afstemningskonklusion: text,
    afgørelse: text,
    afgørelsesdato: optionalTimestamp,
    afgørelsesresultatkode: text,
    lovnummer: text,
    lovnummerdato: optionalTimestamp,
    retsinformationsurl: text,
    fremsatundersagid: id.nullable(),
    deltundersagid: id.nullable(),
    opdateringsdato: timestamp,
  },
  ({ afgørelse, afgørelsesdato, afgørelsesresultatkode, ...row }) => ({
    ...row,
    afgoerelse: afgørelse,
    afgoerelsesdato: afgørelsesdato,
    afgoerelsesresultatkode: afgørelsesresultatkode,
  }),
);
export type Sag = NonNullable<ReturnType<typeof parseSag>>;

// Aktør and SagAktør

const parseAktoer = rowParser(
  {
    id,
    typeid: id,
    navn: text,
    fornavn: text,
    efternavn: text,
    gruppenavnkort: text,
    periodeid: id.nullable(),
    startdato: optionalTimestamp,
    slutdato: optionalTimestamp,
    opdateringsdato: timestamp,
  },
  (row) => row,
);
export type Aktoer = NonNullable<ReturnType<typeof parseAktoer>>;

const parseSagAktoer = rowParser(
  {
    id,
    sagid: id,
    aktørid: id,
    rolleid: id,
    opdateringsdato: timestamp,
    SagAktørRolle: nested(parseRolle).optional(),
  },
  ({ aktørid, SagAktørRolle, ...row }) => ({
    ...row,
    aktoerid: aktørid,
    rolle: SagAktørRolle?.rolle ?? null,
  }),
);
export type SagAktoer = NonNullable<ReturnType<typeof parseSagAktoer>>;

// Emneord and EmneordSag

const parseEmneord = rowParser(
  { id, typeid: id, emneord: text, opdateringsdato: timestamp },
  (row) => row,
);
export type Emneord = NonNullable<ReturnType<typeof parseEmneord>>;

const parseEmneordSag = rowParser(
  {
    id,
    emneordid: id,
    sagid: id,
    opdateringsdato: timestamp,
    Emneord: nested(parseEmneord).optional(),
  },
  ({ Emneord, ...row }) => ({ ...row, emneord: Emneord ?? null }),
);
export type EmneordSag = NonNullable<ReturnType<typeof parseEmneordSag>>;

// Sagstrin

const parseSagstrin = rowParser(
  {
    id,
    sagid: id,
    typeid: id,
    statusid: id,
    titel: text,
    dato: optionalTimestamp,
    folketingstidende: text,
    folketingstidendeurl: text,
    folketingstidendesidenummer: text,
    opdateringsdato: timestamp,
    Sagstrinstype: nested(parseType).optional(),
  },
  ({ Sagstrinstype, ...row }) => ({
    ...row,
    type: Sagstrinstype?.type ?? null,
  }),
);
export type Sagstrin = NonNullable<ReturnType<typeof parseSagstrin>>;

// Afstemning and Stemme

const parseAfstemning = rowParser(
  {
    id,
    sagstrinid: id.nullable(),
    nummer: id,
    typeid: id,
    vedtaget: z.boolean(),
    konklusion: text,
    kommentar: text,
    mødeid: id,
    opdateringsdato: timestamp,
  },
  ({ mødeid, ...row }) => ({ ...row, moedeid: mødeid }),
);
export type Afstemning = NonNullable<ReturnType<typeof parseAfstemning>>;

const parseStemme = rowParser(
  {
    id,
    afstemningid: id,
    aktørid: id,
    typeid: id.nullable(),
    opdateringsdato: timestamp,
    Stemmetype: nested(parseType).optional(),
  },
  ({ aktørid, Stemmetype, ...row }) => ({
    ...row,
    aktoerid: aktørid,
    type: Stemmetype?.type ?? null,
  }),
);
export type Stemme = NonNullable<ReturnType<typeof parseStemme>>;

// Fil, Dokument and SagDokument

const parseFil = rowParser(
  {
    id,
    dokumentid: id,
    titel: text,
    versionsdato: timestamp,
    // The URL extension is unreliable (DOCX is served from `.pdf` URLs):
    // trust `format`, never the URL.
    filurl: text,
    format: text,
    variantkode: text,
    opdateringsdato: timestamp,
  },
  (row) => row,
);
export type Fil = NonNullable<ReturnType<typeof parseFil>>;

const parseDokument = rowParser(
  {
    id,
    typeid: id,
    kategoriid: id,
    statusid: id,
    titel: text,
    dato: timestamp,
    modtagelsesdato: optionalTimestamp,
    frigivelsesdato: optionalTimestamp,
    offentlighedskode: text,
    procedurenummer: text,
    opdateringsdato: timestamp,
    Dokumenttype: nested(parseType).optional(),
    Fil: z.array(nested(parseFil)).optional(),
  },
  ({ Dokumenttype, Fil, ...row }) => ({
    ...row,
    type: Dokumenttype?.type ?? null,
    fil: Fil ?? null,
  }),
);
export type Dokument = NonNullable<ReturnType<typeof parseDokument>>;

const parseSagDokument = rowParser(
  {
    id,
    sagid: id,
    dokumentid: id,
    rolleid: id,
    bilagsnummer: text,
    frigivelsesdato: optionalTimestamp,
    opdateringsdato: timestamp,
    SagDokumentRolle: nested(parseRolle).optional(),
    Dokument: nested(parseDokument).optional(),
  },
  ({ SagDokumentRolle, Dokument, ...row }) => ({
    ...row,
    rolle: SagDokumentRolle?.rolle ?? null,
    dokument: Dokument ?? null,
  }),
);
export type SagDokument = NonNullable<ReturnType<typeof parseSagDokument>>;

/** Row parsers, exported for tests and for callers that page themselves. */
export const odaParsers = {
  Periode: parsePeriode,
  Sag: parseSag,
  Aktør: parseAktoer,
  SagAktør: parseSagAktoer,
  SagAktørRolle: parseRolle,
  Emneord: parseEmneord,
  EmneordSag: parseEmneordSag,
  Sagstrin: parseSagstrin,
  Sagstrinstype: parseType,
  Afstemning: parseAfstemning,
  Stemme: parseStemme,
  Stemmetype: parseType,
  Dokument: parseDokument,
  Dokumenttype: parseType,
  SagDokument: parseSagDokument,
  SagDokumentRolle: parseRolle,
  Fil: parseFil,
} as const;

export type OdaEntity = keyof typeof odaParsers;

type Query<T> = (query?: OdaQuery, options?: OdaRequestOptions) => Promise<T[]>;

function query<E extends OdaEntity>(
  entity: E,
): Query<NonNullable<ReturnType<(typeof odaParsers)[E]>>> {
  const parse = odaParsers[entity] as (
    row: unknown,
  ) => NonNullable<ReturnType<(typeof odaParsers)[E]>> | undefined;
  return (q = {}, options = {}) => odaFetchAll(entity, q, parse, options);
}

/** Sessions, e.g. `{ filter: "type eq 'samling'" }`. */
export const fetchPeriode = query("Periode");
/** Cases. Bills are `typeid eq 3`. */
export const fetchSag = query("Sag");
export const fetchAktoer = query("Aktør");
/** Expand `SagAktørRolle` to fill `rolle`. */
export const fetchSagAktoer = query("SagAktør");
export const fetchSagAktoerRolle = query("SagAktørRolle");
export const fetchEmneord = query("Emneord");
/** Expand `Emneord` to fill `emneord`. */
export const fetchEmneordSag = query("EmneordSag");
/** Expand `Sagstrinstype` to fill `type`. */
export const fetchSagstrin = query("Sagstrin");
export const fetchSagstrinstype = query("Sagstrinstype");
/** A bill's votes: `{ filter: "Sagstrin/sagid eq <id>" }`. */
export const fetchAfstemning = query("Afstemning");
/** Expand `Stemmetype` to fill `type`. */
export const fetchStemme = query("Stemme");
export const fetchStemmetype = query("Stemmetype");
/** Expand `Dokumenttype` to fill `type` and `Fil` to fill `fil`. */
export const fetchDokument = query("Dokument");
export const fetchDokumenttype = query("Dokumenttype");
/** Expand `SagDokumentRolle` to fill `rolle` and `Dokument` to fill `dokument`. */
export const fetchSagDokument = query("SagDokument");
export const fetchSagDokumentRolle = query("SagDokumentRolle");
export const fetchFil = query("Fil");
