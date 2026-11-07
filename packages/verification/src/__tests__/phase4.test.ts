import { loadCompaniesHouseConfig, loadProductsConfig } from "@ae/config";
import { describe, expect, it } from "vitest";
import { adaptiveRate, runBlindVerifier } from "../blind.ts";
import { ingestClaims } from "../ingest.ts";
import { CompaniesHouseClient, fetchCompanyBundle } from "../sources/companies-house/client.ts";
import { mapCompanyBundle } from "../sources/companies-house/mapper.ts";
import {
  companyFromUri,
  consumeStream,
  FakeChangeStream,
  HttpChangeStream,
  parseStreamLine,
  type StreamEvent,
} from "../sources/companies-house/stream.ts";
import { fakeChFetch, profile } from "./fixtures/ch.ts";
import { setup } from "./helpers.ts";

const ch = loadCompaniesHouseConfig();
const bv = loadProductsConfig().blind_verifier;

describe("blind verifier", () => {
  it("adapts the sample rate to disagreement", () => {
    expect(adaptiveRate([], bv)).toBe(bv.base_rate);
    expect(adaptiveRate(Array(50).fill(true), bv)).toBe(Math.max(bv.min_rate, bv.base_rate * 0.5));
    const bad = [...Array(40).fill(true), ...Array(10).fill(false)];
    expect(adaptiveRate(bad, bv)).toBeCloseTo(
      Math.min(bv.max_rate, bv.base_rate * (1 + bv.sensitivity * 0.2)),
      12,
    );
  });

  it("re-derives sampled facts from the source and flags disagreements", async () => {
    const { storage, ctx } = await setup();
    // Ingest real-shaped data, then the source changes status: the blind verifier should notice.
    const client = new CompaniesHouseClient({
      apiKey: "k",
      config: ch,
      fetch: fakeChFetch(),
      sleep: async () => {},
    });
    const run = (await storage.runs.start({ kind: "seed" })).run_id;
    const b = await fetchCompanyBundle(client, "01234567", ch);
    await ingestClaims(
      storage,
      ctx,
      { run_id: run, fetched_at: b.fetched_at },
      (await mapCompanyBundle(b, run, ch)).claims,
    );
    const changed: typeof fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/company/01234567"))
        return Response.json(profile("01234567", { company_status: "liquidation" }));
      return fakeChFetch()(input);
    }) as typeof fetch;
    const fresh = new CompaniesHouseClient({
      apiKey: "k",
      config: ch,
      fetch: changed,
      sleep: async () => {},
    });
    const r = await runBlindVerifier(storage, ctx, fresh, ch, { ...bv, base_rate: 1, max_rate: 1 }); // sample everything
    expect(r.checked).toBeGreaterThan(3);
    expect(r.disagreements).toBe(1);
    expect((await storage.verificationRequests.listOpen(5))[0]?.field).toBe("company_status");
    expect((await storage.blind.summary()).find((x) => x.field === "company_status")).toMatchObject(
      { n: 1, agree: 0 },
    );
  });
});

describe("Companies House Streaming API consumer", () => {
  const ev = (timepoint: number, uri: string): StreamEvent => ({
    stream: "officers",
    timepoint,
    type: "changed",
    published_at: "2026-11-07T10:00:00Z",
    resource_uri: uri,
    company_number: companyFromUri(uri),
  });

  it("turns events for tracked companies into re-verification requests and resumes from the timepoint", async () => {
    const { storage, runId } = await setup();
    await storage.entities.upsertMany(
      [
        {
          entity_id: "01234567",
          name: "A",
          name_normalised: "A",
          postcode: null,
          lad_code: null,
          company_status: "active",
          accounts_category: null,
          sic_codes: [],
          charges_count: null,
          incorporation_date: null,
        },
      ],
      runId,
    );
    const stream = new FakeChangeStream([
      ev(10, "/company/01234567/appointments/x"),
      ev(11, "/company/99999999/appointments/y"),
      ev(12, "/company/01234567/appointments/z"),
    ]);
    const first = await consumeStream(storage, stream, "officers", { max: 2 });
    expect(first).toEqual({ seen: 2, requested: 1, timepoint: 11 });
    const second = await consumeStream(storage, stream, "officers");
    expect(second).toEqual({ seen: 1, requested: 1, timepoint: 12 }); // resumed after 11
    expect((await storage.verificationRequests.listOpen(10)).map((r) => r.reason)).toEqual(
      ["stream:officers:changed", "stream:officers:changed"].flatMap((x) => [x, x]),
    );
  });

  it("the real adapter parses NDJSON with keep-alive lines and resumes with ?timepoint", async () => {
    let asked = "";
    const body =
      '{"resource_uri":"/company/01234567/charges/1","event":{"timepoint":42,"type":"changed","published_at":"2026-11-07T10:00:00Z"}}\n\n';
    const s = new HttpChangeStream("stream-key", "https://stream.example", (async (u: string) => {
      asked = u;
      return new Response(body);
    }) as unknown as typeof fetch);
    const out = [];
    for await (const e of s.events("charges", 41)) out.push(e);
    expect(asked).toBe("https://stream.example/charges?timepoint=42");
    expect(out).toEqual([parseStreamLine("charges", body.split("\n")[0] as string)]);
    expect(out[0]?.company_number).toBe("01234567");
  });
});
