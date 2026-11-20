/**
 * Typed queries, tested end to end through the mocked `fetch` with recorded
 * ODA responses from `tests/fixtures/oda/`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAfstemning,
  fetchAktoer,
  fetchDokumenttype,
  fetchEmneord,
  fetchEmneordSag,
  fetchPeriode,
  fetchSag,
  fetchSagAktoer,
  fetchSagAktoerRolle,
  fetchSagDokument,
  fetchSagDokumentRolle,
  fetchSagstrin,
  fetchSagstrinstype,
  fetchStemme,
  fetchStemmetype,
  odaBaseUrl,
} from "@/lib/oda";
import {
  jsonResponse,
  mockFetch,
  odaFixture,
  odaFixtureText,
  requestedUrls,
} from "@/tests/support/oda";

let fetchMock: ReturnType<typeof mockFetch>;

beforeEach(() => {
  fetchMock = mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers the next requests with the given fixtures, in order. */
function respondWith(...names: string[]) {
  for (const name of names)
    fetchMock.mockResolvedValueOnce(jsonResponse(odaFixtureText(name)));
}

describe("Periode", () => {
  it("parses sessions with Copenhagen timestamps", async () => {
    respondWith("periode-samling");

    const perioder = await fetchPeriode({ filter: "type eq 'samling'" });

    expect(perioder.map((p) => p.id)).toEqual([163, 165, 167, 168]);
    const p = perioder[0];
    expect(p).toMatchObject({
      type: "samling",
      kode: "20241",
      titel: "2024-25",
    });
    // 2024-10-01T12:00:00 in summer time.
    expect(p.startdato.toISOString()).toBe("2024-10-01T10:00:00.000Z");
    // 2024-09-30T13:08:47.483 in summer time.
    expect(p.opdateringsdato.toISOString()).toBe("2024-09-30T11:08:47.483Z");
  });
});

describe("Sag", () => {
  it("parses L 211 (2024-25) and keeps every source field in raw", async () => {
    respondWith("sag-101687");

    const [sag] = await fetchSag({ filter: "id eq 101687" });

    expect(sag).toMatchObject({
      id: 101687,
      typeid: 3,
      periodeid: 163,
      nummer: "L 211",
      lovnummer: "714",
      afgoerelse: null,
      afgoerelsesdato: null,
      fremsatundersagid: null,
    });
    expect(sag.titelkort).toContain("droneaktivitet");
    expect(sag.lovnummerdato?.toISOString()).toBe("2025-06-19T22:00:00.000Z");
    expect(sag.raw).toEqual(odaFixture("sag-101687").value[0]);
    // A field that is not mapped stays available in raw.
    expect(sag.raw.offentlighedskode).toBe("O");
  });

  it("parses L 154 (2024-25)", async () => {
    respondWith("sag-101039");

    const [sag] = await fetchSag({ filter: "id eq 101039" });

    expect(sag).toMatchObject({ id: 101039, nummer: "L 154", periodeid: 163 });
  });
});

describe("SagAktør and Aktør", () => {
  it("maps aktørid to aktoerid", async () => {
    respondWith("sagaktoer-101687");

    const rows = await fetchSagAktoer({ filter: "sagid eq 101687" });

    expect(requestedUrls(fetchMock)[0]).toBe(
      `${odaBaseUrl}/SagAkt%C3%B8r?$filter=sagid%20eq%20101687&$format=json`,
    );
    // Role 6 (Ministerområde) is Forsvarsministeriet, Aktør 11.
    expect(rows.find((r) => r.rolleid === 6)).toMatchObject({
      sagid: 101687,
      aktoerid: 11,
      rolle: null,
    });
    expect(rows[0].raw["aktørid"]).toBe(rows[0].aktoerid);
  });

  it("parses the referenced actors", async () => {
    respondWith("aktoer-referenced");

    const aktoerer = await fetchAktoer();

    expect(aktoerer.find((a) => a.id === 11)).toMatchObject({
      typeid: 1,
      navn: "Forsvarsministeriet",
      slutdato: null,
    });
    expect(requestedUrls(fetchMock)[0]).toBe(
      `${odaBaseUrl}/Akt%C3%B8r?$format=json`,
    );
  });

  it("parses the role lookup table", async () => {
    respondWith("sagaktoerrolle");

    const roller = await fetchSagAktoerRolle();

    expect(roller.find((r) => r.id === 6)?.rolle).toBe("Ministerområde");
  });
});

describe("EmneordSag and Emneord", () => {
  it("fills emneord when Emneord is expanded", async () => {
    respondWith("emneordsag-101687");

    const rows = await fetchEmneordSag({
      filter: "sagid eq 101687",
      expand: "Emneord",
    });

    expect(rows.map((r) => r.emneord?.emneord)).toEqual([
      "Forsvarsvæsen A 51",
      "forsvaret",
    ]);
    expect(rows[1].emneord?.raw).toEqual(
      odaFixture("emneordsag-101687").value[1].Emneord,
    );
  });

  it("parses Emneord", async () => {
    respondWith("emneord-33142");

    const [emneord] = await fetchEmneord({ filter: "id eq 33142" });

    expect(emneord).toMatchObject({
      id: 33142,
      typeid: 1,
      emneord: "forsvaret",
    });
  });
});

describe("Sagstrin", () => {
  it("fills type when Sagstrinstype is expanded", async () => {
    respondWith("sagstrin-101687");

    const trin = await fetchSagstrin({
      filter: "sagid eq 101687",
      expand: "Sagstrinstype",
    });

    expect(trin).toHaveLength(odaFixture("sagstrin-101687").value.length);
    expect(trin[0]).toMatchObject({ sagid: 101687, typeid: 31 });
    expect(trin[0].type).toBe("Fremsættelse");
  });

  it("parses the stage type table across its recorded first page", async () => {
    respondWith("sagstrinstype");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(JSON.stringify({ value: [] })),
    );

    const typer = await fetchSagstrinstype();

    expect(typer[0]).toMatchObject({ id: 1, type: "Anmeldelse" });
    expect(requestedUrls(fetchMock)[1]).toBe(
      odaFixture("sagstrinstype")["odata.nextLink"],
    );
  });
});

describe("Afstemning and Stemme", () => {
  it("queries a bill's votes through Sagstrin", async () => {
    respondWith("afstemning-101039");

    const [afstemning] = await fetchAfstemning({
      filter: "Sagstrin/sagid eq 101039",
    });

    expect(requestedUrls(fetchMock)[0]).toBe(
      `${odaBaseUrl}/Afstemning?$filter=Sagstrin/sagid%20eq%20101039&$format=json`,
    );
    expect(afstemning).toMatchObject({
      id: 10204,
      vedtaget: true,
      moedeid: 14624,
      sagstrinid: 263237,
    });
  });

  it("returns no votes for L 211", async () => {
    respondWith("afstemning-101687");

    expect(
      await fetchAfstemning({ filter: "Sagstrin/sagid eq 101687" }),
    ).toEqual([]);
  });

  it("parses Stemme and the vote type table", async () => {
    respondWith("stemme-10204-p2", "stemmetype");

    const [stemme] = await fetchStemme({ filter: "afstemningid eq 10204" });
    const typer = await fetchStemmetype();

    expect(stemme).toMatchObject({ afstemningid: 10204, type: null });
    expect(stemme.aktoerid).toBe(stemme.raw["aktørid"]);
    expect(typer.map((t) => t.type)).toContain("Hverken for eller imod");
  });
});

describe("SagDokument, Dokument and Fil", () => {
  it("fills dokument and its files when Dokument/Fil is expanded", async () => {
    respondWith("sagdokument-101687");

    const rows = await fetchSagDokument({
      filter: "sagid eq 101687",
      expand: "Dokument/Fil",
    });

    const forslag = rows.filter((r) => r.dokument?.typeid === 21);
    expect(forslag.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.sagid).toBe(101687);
      expect(row.dokument?.id).toBe(row.dokumentid);
      expect(row.dokument?.fil?.length).toBeGreaterThan(0);
    }
    // DOCX files are served from URLs ending in .pdf: format is the truth.
    const docx = rows
      .flatMap((r) => r.dokument?.fil ?? [])
      .find((f) => f.format === "DOCX");
    expect(docx?.filurl).toMatch(/\.pdf$/);
  });

  it("parses L 154's documents", async () => {
    respondWith("sagdokument-101039");

    const rows = await fetchSagDokument({ expand: "Dokument/Fil" });

    expect(rows.every((r) => r.sagid === 101039)).toBe(true);
    expect(rows[0].dokument?.raw).toEqual(
      odaFixture("sagdokument-101039").value[0].Dokument,
    );
  });

  it("parses the document type and role tables", async () => {
    respondWith("dokumenttype", "sagdokumentrolle");

    const typer = await fetchDokumenttype();
    const roller = await fetchSagDokumentRolle();

    expect(typer.find((t) => t.id === 21)?.type).toBe("Forslagstekst");
    expect(roller.map((r) => r.rolle)).toContain("Hovedtilknytning");
  });
});
