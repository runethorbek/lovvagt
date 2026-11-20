/**
 * `npx tsx scripts/topics-dry-run.ts [--per-bill]`
 *
 * Dry run of the topic rules (`lib/ingest/topics.ts`) over every bill
 * (Lovforslag) in the sessions from 2024-25 on, fetched live through the ODA
 * client. Nothing is stored. Prints the candidate count per topic, the
 * candidates per topic with their matched rules, and per keyword the bills
 * it matched, so noisy patterns can be judged.
 *
 * Requests are sequential (the ODA client enforces that). By default a
 * session's SagAktør and EmneordSag rows are fetched in bulk with navigation
 * filters (`Sag/periodeid eq <id>`). If ODA rejects those, `--per-bill`
 * fetches them with one request per bill and kind instead (slower).
 *
 * Not run in CI. Reads no environment variables.
 */
import {
  type Aktoer,
  type EmneordSag,
  OdaError,
  type Sag,
  type SagAktoer,
  fetchAktoer,
  fetchEmneordSag,
  fetchPeriode,
  fetchSag,
  fetchSagAktoer,
} from "@/lib/oda";
import {
  type TopicMatch,
  matchTopics,
  ministeromraadeRolleId,
  topicInput,
  topicRules,
} from "@/lib/ingest/topics";

/** Sessions that start on or after this Copenhagen date (spec 002). */
const firstSessionStart = new Date("2024-10-01T00:00:00+02:00");

type Evaluated = {
  session: string;
  sag: Sag;
  ministries: readonly string[];
  matches: TopicMatch[];
};

function label(item: Evaluated): string {
  return `${item.session} ${item.sag.nummer ?? `Sag ${item.sag.id}`}: ${item.sag.titelkort ?? item.sag.titel ?? ""}`.trim();
}

function rulesText(match: TopicMatch): string {
  const rules = match.matchedRules.map(
    (rule) => `${rule.kind}:${rule.value}@${rule.field}`,
  );
  const excluded = match.excludedBy.map(
    (exclusion) => `exclusion:${exclusion.value}@${exclusion.field}`,
  );
  return [...rules, ...excluded].join(", ");
}

async function relatedRows(
  sessionId: number,
  bills: Sag[],
  perBill: boolean,
): Promise<{ sagAktoer: SagAktoer[]; emneordSag: EmneordSag[] }> {
  if (!perBill) {
    const scope = `Sag/typeid eq 3 and Sag/periodeid eq ${sessionId}`;
    return {
      sagAktoer: await fetchSagAktoer({
        filter: `rolleid eq ${ministeromraadeRolleId} and ${scope}`,
      }),
      emneordSag: await fetchEmneordSag({ filter: scope, expand: "Emneord" }),
    };
  }
  const sagAktoer: SagAktoer[] = [];
  const emneordSag: EmneordSag[] = [];
  for (const sag of bills) {
    sagAktoer.push(
      ...(await fetchSagAktoer({
        filter: `sagid eq ${sag.id} and rolleid eq ${ministeromraadeRolleId}`,
      })),
    );
    emneordSag.push(
      ...(await fetchEmneordSag({
        filter: `sagid eq ${sag.id}`,
        expand: "Emneord",
      })),
    );
  }
  return { sagAktoer, emneordSag };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--per-bill");
  if (unknown.length > 0) {
    console.error("Usage: npx tsx scripts/topics-dry-run.ts [--per-bill]");
    return 2;
  }
  const perBill = args.includes("--per-bill");

  const sessions = (await fetchPeriode({ filter: "type eq 'samling'" }))
    .filter((periode) => periode.startdato >= firstSessionStart)
    .sort((a, b) => a.startdato.getTime() - b.startdato.getTime());
  const aktoerer: Aktoer[] = await fetchAktoer({ filter: "typeid eq 1" });
  const aktoerNames = new Map(aktoerer.map((a) => [a.id, a.navn]));
  console.log(
    `Sessions: ${sessions.map((s) => `${s.titel} (${s.id})`).join(", ")}`,
  );
  console.log(`Ministries (Aktør typeid 1): ${aktoerer.length}`);

  const evaluated: Evaluated[] = [];
  const ministryCounts = new Map<string, number>();
  let unknownMinistries = 0;
  for (const session of sessions) {
    const name = session.titel ?? String(session.id);
    const bills = await fetchSag({
      filter: `typeid eq 3 and periodeid eq ${session.id}`,
    });
    const { sagAktoer, emneordSag } = await relatedRows(
      session.id,
      bills,
      perBill,
    );
    const billIds = new Set(bills.map((sag) => sag.id));
    const ministryRows = sagAktoer.filter(
      (row) => row.rolleid === ministeromraadeRolleId && billIds.has(row.sagid),
    );
    const withMinistry = new Set(ministryRows.map((row) => row.sagid));
    const withEmneord = new Set(
      emneordSag.filter((row) => billIds.has(row.sagid)).map((r) => r.sagid),
    );
    console.log(
      `${name}: ${bills.length} bills, ${withMinistry.size} with a ministry, ${withEmneord.size} with Emneord`,
    );
    for (const row of ministryRows) {
      const navn = aktoerNames.get(row.aktoerid);
      if (typeof navn !== "string") unknownMinistries += 1;
      else ministryCounts.set(navn, (ministryCounts.get(navn) ?? 0) + 1);
    }

    for (const sag of bills) {
      const input = topicInput(sag, sagAktoer, aktoerer, emneordSag);
      evaluated.push({
        session: name,
        sag,
        ministries: input.ministries,
        matches: matchTopics(input),
      });
    }
  }
  if (unknownMinistries > 0)
    console.log(
      `WARNING: ${unknownMinistries} role 6 row(s) name an Aktør that is not a known ministry`,
    );

  const candidates = evaluated.filter((item) =>
    item.matches.some((match) => match.matching),
  );
  console.log(`\nBills evaluated: ${evaluated.length}`);
  console.log(`Distinct candidates: ${candidates.length}`);
  for (const rules of topicRules) {
    const count = evaluated.filter((item) =>
      item.matches.some((m) => m.topic === rules.topic && m.matching),
    ).length;
    console.log(`  ${rules.topic}: ${count}`);
  }

  for (const rules of topicRules) {
    const topicCandidates = evaluated.flatMap((item) =>
      item.matches
        .filter((m) => m.topic === rules.topic && m.matching)
        .map((m) => ({ item, match: m })),
    );
    console.log(`\n## ${rules.topic} (${topicCandidates.length})`);
    for (const { item, match } of topicCandidates)
      console.log(`- ${label(item)}\n    ${rulesText(match)}`);

    const cancelled = evaluated.flatMap((item) =>
      item.matches
        .filter((m) => m.topic === rules.topic && m.excludedBy.length > 0)
        .map((m) => ({ item, match: m })),
    );
    if (cancelled.length > 0) {
      console.log(`\n### ${rules.topic}: cancelled by exclusions`);
      for (const { item, match } of cancelled)
        console.log(`- ${label(item)}\n    ${rulesText(match)}`);
    }

    console.log(`\n### ${rules.topic}: keywords`);
    for (const keyword of rules.keywords) {
      const hits = evaluated.flatMap((item) =>
        item.matches
          .filter((m) => m.topic === rules.topic)
          .filter((m) =>
            m.matchedRules.some(
              (r) => r.kind === "keyword" && r.value === keyword.text,
            ),
          )
          .map((m) => ({ item, match: m })),
      );
      // Bills that are candidates only because of this keyword.
      const only = hits.filter(
        ({ match }) =>
          match.matching &&
          match.matchedRules.every(
            (r) => r.kind === "keyword" && r.value === keyword.text,
          ),
      );
      console.log(
        `- ${keyword.text} (${keyword.match}): ${hits.length} bill(s), ${only.length} only via this keyword`,
      );
      for (const { item, match } of only)
        console.log(
          `    only: ${label(item)} [${match.matchedRules.map((r) => r.field).join(", ")}]`,
        );
    }
  }

  console.log("\n## Ministries on bills (role 6), by bill count");
  const listed = new Set(topicRules.flatMap((rules) => rules.ministries));
  for (const [navn, count] of [...ministryCounts].sort((a, b) => b[1] - a[1]))
    console.log(`- ${navn}: ${count}${listed.has(navn) ? " (listed)" : ""}`);

  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // ODA errors carry fixed messages only; anything else is reported
    // generically.
    console.error(
      error instanceof OdaError
        ? error.message
        : "topics dry run failed with an unexpected error",
    );
    process.exitCode = 1;
  },
);
