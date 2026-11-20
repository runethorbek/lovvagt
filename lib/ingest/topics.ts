/**
 * Candidate selection (spec 002, deliverable 3): the topic rules and a pure
 * function that evaluates them for one bill (Lovforslag).
 *
 * A bill is a candidate for a topic if **any** of its rules matches:
 *
 * - **Ministry** (`kind: "ministry"`, `field: "ministeromraade"`): the name
 *   of an Aktør linked by SagAktør role 6 (`Ministerområde`) is listed.
 *   Names are compared exactly and case-sensitively: they come verbatim from
 *   ODA's `Aktør` table, so the config lists them as ODA spells them.
 * - **Keyword** (`kind: "keyword"`, `field: "titel" | "titelkort" |
 *   "resume"`): a keyword pattern matches one of the three text fields.
 * - **Emneord** (`kind: "emneord"`, `field: "emneord"`): one of the bill's
 *   Emneord is listed. Compared exactly and case-sensitively, like
 *   ministries.
 *
 * Keyword patterns (also used for exclusions) are matched like this:
 *
 * - Case-insensitive, with Unicode case folding, so `æ` matches `Æ`.
 * - The start of a pattern must be at a word start: the character before it
 *   must not be a Unicode letter or digit (`\p{L}`, `\p{N}`). JavaScript's
 *   `\b` is ASCII-only and would treat `ø` as a boundary.
 * - A `word` pattern must also end at a word end (the next character is not
 *   a letter or digit), so `PET` matches `PET` and `PET-loven` but not
 *   `kompetence` or `Peter`. A `stem` pattern is a prefix and may be
 *   followed by anything, so `forsvaret` matches `Forsvarets` and `forsvars`
 *   matches `forsvarssamarbejde`. The seed's trailing `-` (`forsvars-`,
 *   `krigs-`, `algoritm-`) marks such compound prefixes; it is not part of
 *   the pattern.
 * - Whitespace in a pattern matches any run of whitespace. Every other
 *   character matches itself literally.
 *
 * **Exclusions** cancel a topic whose matches are all keyword matches, when
 * any exclusion pattern matches any of the three text fields. They never
 * cancel a ministry or Emneord match. A cancelled topic has
 * `matching: false`, still lists its keyword matches in `matchedRules`, and
 * lists the exclusions that cancelled it in `excludedBy` (empty unless the
 * topic was cancelled).
 *
 * The rules are a typed object reviewed in pull requests. Tuning proposals
 * come from the dry run (`scripts/topics-dry-run.ts`).
 */
import type { Aktoer, EmneordSag, Sag, SagAktoer } from "@/lib/oda";

export type Topic = "defence" | "security" | "ai";

/** A keyword or exclusion pattern. See the module comment for matching. */
export type KeywordPattern = {
  readonly text: string;
  readonly match: "word" | "stem";
};

export type TopicRules = {
  readonly topic: Topic;
  /** Aktør names of ministries (SagAktør role 6), exactly as in ODA. */
  readonly ministries: readonly string[];
  readonly keywords: readonly KeywordPattern[];
  /** Emneord values, exactly as in ODA. */
  readonly emneord: readonly string[];
  /** Cancel keyword-only matches. */
  readonly exclusions: readonly KeywordPattern[];
};

/** A whole-word pattern. */
function word(text: string): KeywordPattern {
  return { text, match: "word" };
}

/** A prefix pattern: the word may continue after it. */
function stem(text: string): KeywordPattern {
  return { text, match: "stem" };
}

/**
 * The seed rules approved in spec 002 (2026-11-19). Ministry names were
 * checked against ODA's `Aktør` table (typeid 1) on 2026-11-20 and include
 * every name in use since 2024.
 */
export const topicRules: readonly TopicRules[] = [
  {
    topic: "defence",
    ministries: ["Forsvarsministeriet"],
    keywords: [
      stem("forsvaret"),
      stem("forsvars"),
      stem("militær"),
      stem("værnepligt"),
      word("NATO"),
      stem("våben"),
      stem("krigs"),
      stem("drone"),
    ],
    emneord: [],
    exclusions: [stem("forsvarer"), stem("forsvarsadvokat")],
  },
  {
    topic: "security",
    ministries: ["Ministeriet for Samfundssikkerhed og Beredskab"],
    keywords: [
      stem("cybersikkerhed"),
      stem("informationssikkerhed"),
      word("NIS 2"),
      stem("efterretningstjeneste"),
      word("PET"),
      word("FE"),
      stem("terror"),
      stem("spionage"),
      stem("kritisk infrastruktur"),
      stem("samfundssikkerhed"),
      stem("beredskab"),
      stem("hybrid"),
      stem("sabotage"),
    ],
    emneord: [],
    exclusions: [],
  },
  {
    topic: "ai",
    ministries: [
      // Aktør 20986, 2024-08-29 to 2026-06-03.
      "Digitaliseringsministeriet",
      // Aktør 21435, from 2026-06-03.
      "Forsknings-, Uddannelses- og Digitaliseringsministeriet",
      // Aktør 20431, 2022-12-15 to 2024-08-29. Not in the seed table; added
      // because the spec asks for every name in use since 2024.
      "Ministeriet for Digitalisering og Ligestilling",
    ],
    keywords: [
      stem("kunstig intelligens"),
      stem("AI-forordning"),
      stem("forordningen om kunstig intelligens"),
      stem("algoritm"),
      stem("automatiseret afgørelse"),
      stem("maskinlæring"),
      stem("ansigtsgenkendelse"),
    ],
    emneord: [],
    exclusions: [],
  },
];

/** The bill fields the rules look at. */
export type TopicInput = {
  readonly titel: string | null;
  readonly titelkort: string | null;
  readonly resume: string | null;
  /** Aktør names of the bill's ministries (SagAktør role 6). */
  readonly ministries: readonly string[];
  /** The bill's Emneord values. */
  readonly emneord: readonly string[];
};

export const keywordFields = ["titel", "titelkort", "resume"] as const;
export type KeywordField = (typeof keywordFields)[number];

export type MatchedRule =
  | { kind: "ministry"; value: string; field: "ministeromraade" }
  | { kind: "keyword"; value: string; field: KeywordField }
  | { kind: "emneord"; value: string; field: "emneord" };

/** An exclusion pattern that matched a text field. */
export type ExclusionMatch = { value: string; field: KeywordField };

export type TopicMatch = {
  topic: Topic;
  matching: boolean;
  /** Every rule that matched, including keyword matches an exclusion cancelled. */
  matchedRules: MatchedRule[];
  /** The exclusions that cancelled the topic; empty unless `matching` was cancelled. */
  excludedBy: ExclusionMatch[];
};

/** SagAktør role 6, `Ministerområde`: the responsible ministry. */
export const ministeromraadeRolleId = 6;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compiles a keyword pattern to a Unicode-aware, case-insensitive RegExp. */
export function keywordRegExp(pattern: KeywordPattern): RegExp {
  const body = pattern.text.trim().split(/\s+/u).map(escapeRegExp).join("\\s+");
  const end = pattern.match === "word" ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${end}`, "iu");
}

/** The text fields a pattern matches, in `keywordFields` order. */
function matchingFields(
  input: TopicInput,
  pattern: KeywordPattern,
): KeywordField[] {
  const regExp = keywordRegExp(pattern);
  return keywordFields.filter((field) => {
    const value = input[field];
    return value !== null && regExp.test(value);
  });
}

/**
 * Evaluates the rules for one bill. Returns one entry per topic, in the
 * order of `rules`. Pure: no I/O and no configuration.
 */
export function matchTopics(
  input: TopicInput,
  rules: readonly TopicRules[] = topicRules,
): TopicMatch[] {
  return rules.map((topic) => {
    const matchedRules: MatchedRule[] = [];
    for (const ministry of topic.ministries)
      if (input.ministries.includes(ministry))
        matchedRules.push({
          kind: "ministry",
          value: ministry,
          field: "ministeromraade",
        });
    for (const keyword of topic.keywords)
      for (const field of matchingFields(input, keyword))
        matchedRules.push({ kind: "keyword", value: keyword.text, field });
    for (const emneord of topic.emneord)
      if (input.emneord.includes(emneord))
        matchedRules.push({
          kind: "emneord",
          value: emneord,
          field: "emneord",
        });

    const keywordOnly =
      matchedRules.length > 0 &&
      matchedRules.every((rule) => rule.kind === "keyword");
    const excludedBy: ExclusionMatch[] = keywordOnly
      ? topic.exclusions.flatMap((exclusion) =>
          matchingFields(input, exclusion).map((field) => ({
            value: exclusion.text,
            field,
          })),
        )
      : [];

    return {
      topic: topic.topic,
      matching: matchedRules.length > 0 && excludedBy.length === 0,
      matchedRules,
      excludedBy,
    };
  });
}

/**
 * Builds the input for one bill from ODA rows. The other arguments may hold
 * rows for many bills: only rows with `sagid` equal to `sag.id` are used.
 *
 * - `sagAktoer`: SagAktør rows; only role 6 (`Ministerområde`) is used.
 * - `aktoerer`: Aktør rows that name the ministries. A ministry whose Aktør
 *   is missing or has no name is left out.
 * - `emneordSag`: EmneordSag rows fetched with `$expand=Emneord`. Rows
 *   without the expanded Emneord, or with no value, are left out.
 */
export function topicInput(
  sag: Pick<Sag, "id" | "titel" | "titelkort" | "resume">,
  sagAktoer: readonly SagAktoer[],
  aktoerer: readonly Aktoer[],
  emneordSag: readonly EmneordSag[],
): TopicInput {
  const names = new Map(aktoerer.map((aktoer) => [aktoer.id, aktoer.navn]));
  const ministries = sagAktoer
    .filter((row) => row.sagid === sag.id)
    .filter((row) => row.rolleid === ministeromraadeRolleId)
    .map((row) => names.get(row.aktoerid))
    .filter((name): name is string => typeof name === "string");
  const emneord = emneordSag
    .filter((row) => row.sagid === sag.id)
    .map((row) => row.emneord?.emneord)
    .filter((value): value is string => typeof value === "string");
  return {
    titel: sag.titel,
    titelkort: sag.titelkort,
    resume: sag.resume,
    ministries,
    emneord,
  };
}
