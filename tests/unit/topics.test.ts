/**
 * Topic rules (spec 002, deliverable 3): the known positives and negatives
 * on recorded ODA fixtures, plus the matching semantics on synthetic input.
 */
import { describe, expect, it } from "vitest";
import {
  keywordRegExp,
  matchTopics,
  topicInput,
  topicRules,
  type Topic,
  type TopicInput,
  type TopicRules,
} from "@/lib/ingest/topics";
import { odaParsers } from "@/lib/oda";
import { odaFixture } from "@/tests/support/oda";

/** Parses every row of a fixture; fails the test on an invalid row. */
function rows<T>(name: string, parse: (row: unknown) => T | undefined): T[] {
  return odaFixture(name).value.map((row) => {
    const parsed = parse(row);
    if (parsed === undefined) throw new Error(`invalid row in ${name}`);
    return parsed;
  });
}

/** The topic input for a recorded bill, built from its fixtures. */
function fixtureInput(sagId: number): TopicInput {
  const [sag] = rows(`sag-${sagId}`, odaParsers.Sag);
  return topicInput(
    sag,
    rows(`sagaktoer-${sagId}`, odaParsers.SagAktør),
    rows("aktoer-ministerier", odaParsers.Aktør),
    rows(`emneordsag-${sagId}`, odaParsers.EmneordSag),
  );
}

function matchingTopics(input: TopicInput): Topic[] {
  return matchTopics(input)
    .filter((match) => match.matching)
    .map((match) => match.topic);
}

function input(fields: Partial<TopicInput>): TopicInput {
  return {
    titel: null,
    titelkort: null,
    resume: null,
    ministries: [],
    emneord: [],
    ...fields,
  };
}

function topicMatch(result: ReturnType<typeof matchTopics>, topic: Topic) {
  const match = result.find((entry) => entry.topic === topic);
  if (match === undefined) throw new Error(`no result for ${topic}`);
  return match;
}

describe("known bills from 2024-25", () => {
  // `topics` are the expected topics from the acceptance criteria. `also`
  // pins further matches the wide net makes: L 211's resume names terror,
  // spionage and sabotage, so it is a security candidate too.
  it.each([
    { nummer: "L 154", sagId: 101039, topics: ["ai"], also: [] },
    { nummer: "L 152", sagId: 101043, topics: ["ai"], also: [] },
    { nummer: "L 141", sagId: 69354, topics: ["security"], also: [] },
    { nummer: "L 211", sagId: 101687, topics: ["defence"], also: ["security"] },
    { nummer: "L 188", sagId: 101403, topics: ["defence"], also: [] },
    { nummer: "L 210", sagId: 101688, topics: ["defence"], also: [] },
    { nummer: "L 31", sagId: 99215, topics: [], also: [] },
  ])(
    "$nummer (Sag $sagId) matches $topics",
    ({ nummer, sagId, topics, also }) => {
      const [sag] = rows(`sag-${sagId}`, odaParsers.Sag);
      expect(sag.nummer).toBe(nummer);
      expect(sag.periodeid).toBe(163);

      const matching = matchingTopics(fixtureInput(sagId));
      expect(matching).toEqual(expect.arrayContaining(topics));
      expect([...matching].sort()).toEqual([...topics, ...also].sort());
    },
  );

  it("records why L 211 and L 154 match: their ministries", () => {
    expect(topicMatch(matchTopics(fixtureInput(101687)), "defence")).toEqual(
      expect.objectContaining({
        matchedRules: expect.arrayContaining([
          {
            kind: "ministry",
            value: "Forsvarsministeriet",
            field: "ministeromraade",
          },
        ]),
      }),
    );
    expect(
      topicMatch(matchTopics(fixtureInput(101039)), "ai").matchedRules,
    ).toContainEqual({
      kind: "ministry",
      value: "Digitaliseringsministeriet",
      field: "ministeromraade",
    });
  });

  it("matches L 210 on Forsvarets, a stem of forsvaret, with no ministry", () => {
    const result = topicMatch(matchTopics(fixtureInput(101688)), "defence");
    expect(result.matchedRules).toContainEqual({
      kind: "keyword",
      value: "forsvaret",
      field: "titelkort",
    });
    expect(result.matchedRules.map((rule) => rule.kind)).not.toContain(
      "ministry",
    );
  });

  it("builds the input from the bill's role 6 ministry and its Emneord", () => {
    expect(fixtureInput(69354)).toMatchObject({
      ministries: ["Ministeriet for Samfundssikkerhed og Beredskab"],
      emneord: [
        "Forsvarsvæsen A 62",
        "cybersikkerhed og informationssikkerhed",
      ],
    });
  });

  it("matches L 188 and L 141 on their Emneord too", () => {
    expect(
      topicMatch(matchTopics(fixtureInput(101403)), "defence").matchedRules,
    ).toContainEqual({ kind: "emneord", value: "NATO", field: "emneord" });
    expect(
      topicMatch(matchTopics(fixtureInput(69354)), "security").matchedRules,
    ).toContainEqual({
      kind: "emneord",
      value: "cybersikkerhed og informationssikkerhed",
      field: "emneord",
    });
  });
});

describe("topicInput", () => {
  it("uses only the bill's own rows, role 6 and named Aktører", () => {
    const [sag] = rows("sag-101043", odaParsers.Sag);
    const sagAktoer = [
      ...rows("sagaktoer-101043", odaParsers.SagAktør),
      ...rows("sagaktoer-101687", odaParsers.SagAktør),
    ];
    const emneordSag = [
      ...rows("emneordsag-101043", odaParsers.EmneordSag),
      ...rows("emneordsag-101687", odaParsers.EmneordSag),
    ];

    const result = topicInput(
      sag,
      sagAktoer,
      rows("aktoer-ministerier", odaParsers.Aktør),
      emneordSag,
    );

    expect(result.ministries).toEqual([
      "Uddannelses- og Forskningsministeriet",
    ]);
    expect(result.emneord).toEqual([
      "Undervisningsvæsen 48",
      "uddannelsesstøtte",
    ]);
  });

  it("leaves out a ministry whose Aktør is unknown", () => {
    const [sag] = rows("sag-101043", odaParsers.Sag);
    const result = topicInput(
      sag,
      rows("sagaktoer-101043", odaParsers.SagAktør),
      [],
      [],
    );
    expect(result.ministries).toEqual([]);
  });
});

describe("exclusions", () => {
  it("from the tuning cancel keyword-only security and defence matches", () => {
    const security = topicMatch(
      matchTopics(input({ titel: "Om hvidvask og terrorfinansiering" })),
      "security",
    );
    expect(security.matching).toBe(false);
    expect(security.matchedRules).toEqual([
      { kind: "keyword", value: "terror", field: "titel" },
    ]);
    expect(security.excludedBy).toEqual([
      { value: "terrorfinansiering", field: "titel" },
      { value: "hvidvask", field: "titel" },
    ]);

    const defence = topicMatch(
      matchTopics(input({ titel: "Om krigsramte og skydevåben" })),
      "defence",
    );
    expect(defence.matching).toBe(false);
    expect(defence.excludedBy).toEqual([
      { value: "skydevåben", field: "titel" },
      { value: "krigsramte", field: "titel" },
    ]);
  });

  it("cancel a keyword-only match and are reported", () => {
    const result = topicMatch(
      matchTopics(
        input({ titel: "Om forsvarsadvokater og forsvarets ordning" }),
      ),
      "defence",
    );

    expect(result.matching).toBe(false);
    expect(result.matchedRules).toEqual([
      { kind: "keyword", value: "forsvaret", field: "titel" },
      { kind: "keyword", value: "forsvars", field: "titel" },
    ]);
    expect(result.excludedBy).toEqual([
      { value: "forsvarsadvokat", field: "titel" },
    ]);
  });

  it("cancel a keyword match when the exclusion is in another field", () => {
    const result = topicMatch(
      matchTopics(input({ titel: "Om militær", resume: "En forsvarer." })),
      "defence",
    );
    expect(result.matching).toBe(false);
    expect(result.excludedBy).toEqual([
      { value: "forsvarer", field: "resume" },
    ]);
  });

  it("do not cancel a ministry match", () => {
    const result = topicMatch(
      matchTopics(
        input({
          titel: "Om forsvarerbistand i militære straffesager",
          ministries: ["Forsvarsministeriet"],
        }),
      ),
      "defence",
    );

    expect(result.matching).toBe(true);
    expect(result.excludedBy).toEqual([]);
    expect(result.matchedRules).toEqual([
      {
        kind: "ministry",
        value: "Forsvarsministeriet",
        field: "ministeromraade",
      },
      { kind: "keyword", value: "militær", field: "titel" },
    ]);
  });

  it("do not cancel an Emneord match", () => {
    const rules: TopicRules[] = [
      {
        topic: "defence",
        ministries: [],
        keywords: [{ text: "militær", match: "stem" }],
        emneord: ["forsvar"],
        exclusions: [{ text: "forsvarer", match: "stem" }],
      },
    ];
    const [result] = matchTopics(
      input({ titel: "Militær og forsvarer", emneord: ["forsvar"] }),
      rules,
    );
    expect(result.matching).toBe(true);
    expect(result.excludedBy).toEqual([]);
  });

  it("are not reported when nothing matched", () => {
    const result = topicMatch(
      matchTopics(input({ titel: "Om forsvarerbistand" })),
      "defence",
    );
    expect(result).toEqual({
      topic: "defence",
      matching: false,
      matchedRules: [],
      excludedBy: [],
    });
  });
});

describe("keyword patterns", () => {
  it("match whole words only for word patterns, even next to æ, ø, å", () => {
    const pet = keywordRegExp({ text: "PET", match: "word" });
    expect(pet.test("kompetence")).toBe(false);
    expect(pet.test("Peter")).toBe(false);
    expect(pet.test("PETs")).toBe(false);
    expect(pet.test("øPET")).toBe(false);
    expect(pet.test("PETø")).toBe(false);
    expect(pet.test("PET2")).toBe(false);
    expect(pet.test("Politiets Efterretningstjeneste (PET)")).toBe(true);
    expect(pet.test("PET-loven")).toBe(true);
    expect(pet.test("pet")).toBe(true);
  });

  it("match prefixes for stem patterns, but only at a word start", () => {
    const krigs = keywordRegExp({ text: "krigs", match: "stem" });
    expect(krigs.test("krigsforbrydelser")).toBe(true);
    expect(krigs.test("KRIGSSKIBE")).toBe(true);
    expect(krigs.test("efterkrigstiden")).toBe(false);
    expect(krigs.test("økrigs")).toBe(false);
    expect(krigs.test("krig")).toBe(false);
  });

  it("fold case for æ, ø and å", () => {
    const vaaben = keywordRegExp({ text: "våben", match: "stem" });
    expect(vaaben.test("VÅBENLOVEN")).toBe(true);
    const vaerne = keywordRegExp({ text: "værnepligt", match: "stem" });
    expect(vaerne.test("Værnepligtige")).toBe(true);
  });

  it("match any whitespace between words and other characters literally", () => {
    const nis = keywordRegExp({ text: "NIS 2", match: "word" });
    expect(nis.test("NIS 2-loven")).toBe(true);
    expect(nis.test("NIS 2")).toBe(true);
    expect(nis.test("NIS  2")).toBe(true);
    expect(nis.test("NIS2")).toBe(false);
    expect(nis.test("NIS 20")).toBe(false);
    const ai = keywordRegExp({ text: "AI-forordning", match: "stem" });
    expect(ai.test("AI-forordningen")).toBe(true);
    expect(ai.test("AI forordningen")).toBe(false);
  });

  it("does not match PET in kompetence through the seed rules", () => {
    const result = topicMatch(
      matchTopics(input({ titel: "Om kompetenceudvikling" })),
      "security",
    );
    expect(result.matching).toBe(false);
    expect(result.matchedRules).toEqual([]);
  });
});

describe("ai rules", () => {
  it("do not list the merged education and digitalisation ministry", () => {
    const merged = topicMatch(
      matchTopics(
        input({
          ministries: [
            "Forsknings-, Uddannelses- og Digitaliseringsministeriet",
          ],
        }),
      ),
      "ai",
    );
    expect(merged.matching).toBe(false);
    expect(merged.matchedRules).toEqual([]);

    const digital = topicMatch(
      matchTopics(input({ ministries: ["Digitaliseringsministeriet"] })),
      "ai",
    );
    expect(digital.matching).toBe(true);
  });

  it("match AI-system and AI-lov stems", () => {
    const result = topicMatch(
      matchTopics(input({ titel: "Om AI-systemer", resume: "En ny AI-lov." })),
      "ai",
    );
    expect(result.matchedRules).toEqual([
      { kind: "keyword", value: "AI-system", field: "titel" },
      { kind: "keyword", value: "AI-lov", field: "resume" },
    ]);
  });
});

describe("matched rules", () => {
  it("are returned with kind, value and field for each source", () => {
    const rules: TopicRules[] = [
      {
        topic: "security",
        ministries: ["Ministeriet for Samfundssikkerhed og Beredskab"],
        keywords: [
          { text: "PET", match: "word" },
          { text: "beredskab", match: "stem" },
        ],
        emneord: ["cybersikkerhed og informationssikkerhed"],
        exclusions: [],
      },
    ];

    const [result] = matchTopics(
      input({
        titel: "Om PET",
        titelkort: "Om beredskabet",
        resume: "PET og beredskab.",
        ministries: ["Ministeriet for Samfundssikkerhed og Beredskab"],
        emneord: ["cybersikkerhed og informationssikkerhed", "andet"],
      }),
      rules,
    );

    expect(result).toEqual({
      topic: "security",
      matching: true,
      matchedRules: [
        {
          kind: "ministry",
          value: "Ministeriet for Samfundssikkerhed og Beredskab",
          field: "ministeromraade",
        },
        { kind: "keyword", value: "PET", field: "titel" },
        { kind: "keyword", value: "PET", field: "resume" },
        { kind: "keyword", value: "beredskab", field: "titelkort" },
        { kind: "keyword", value: "beredskab", field: "resume" },
        {
          kind: "emneord",
          value: "cybersikkerhed og informationssikkerhed",
          field: "emneord",
        },
      ],
      excludedBy: [],
    });
  });

  it("compare ministries and Emneord exactly and case-sensitively", () => {
    const rules: TopicRules[] = [
      {
        topic: "ai",
        ministries: ["Digitaliseringsministeriet"],
        keywords: [],
        emneord: ["NATO"],
        exclusions: [],
      },
    ];
    const [result] = matchTopics(
      input({
        ministries: [
          "digitaliseringsministeriet",
          "Digitaliseringsministeriet ",
        ],
        emneord: ["nato", "NATO-samarbejde"],
      }),
      rules,
    );
    expect(result.matching).toBe(false);
    expect(result.matchedRules).toEqual([]);
  });

  it("are listed for every topic in config order", () => {
    expect(matchTopics(input({})).map((match) => match.topic)).toEqual(
      topicRules.map((rules) => rules.topic),
    );
    expect(topicRules.map((rules) => rules.topic)).toEqual([
      "defence",
      "security",
      "ai",
    ]);
  });
});
