import type { Storage } from "@ae/storage";
import { beforeEach, describe, expect, it } from "vitest";
import type { VerificationContext } from "../context.ts";
import { compareToBaseline, computeDrift, resumeSource, runDriftCheck } from "../drift.ts";
import { ingestClaims } from "../ingest.ts";
import { accuracyReport, recordGolden, resolveConflict } from "../measurement.ts";
import { getVerifiedFacts } from "../query.ts";
import { chClaim, setup } from "./helpers.ts";

let storage: Storage;
let ctx: VerificationContext;
let runId: string;
const today = new Date().toISOString().slice(0, 10);
const NOW = `${today}T08:00:00Z`;

beforeEach(async () => {
  ({ storage, ctx, runId } = await setup());
});

const ingest = (claims: Awaited<ReturnType<typeof chClaim>>[]) =>
  ingestClaims(storage, ctx, { run_id: runId, fetched_at: NOW }, claims);

describe("golden set and Archie's verification", () => {
  it("Archie's value wins over a source and the company joins the golden set", async () => {
    await ingest([
      await chClaim(runId, {
        field: "employees_average",
        value: 12,
        published: "2026-01-01T00:00:00Z",
        source: "companies_house_accounts",
        fetched: NOW,
      }),
    ]);
    await recordGolden(storage, ctx, "01234567", { employees_average: 30 });
    const f = await storage.facts.getCurrent("01234567", "employees_average");
    expect(f?.value).toBe(30);
    expect(f?.status).toBe("verified");
    expect(f?.conflicting_claims).toHaveLength(1);
    expect((await storage.golden.list()).map((g) => g.entity_id)).toEqual(["01234567"]);
  });

  it("resolving a conflict is a human claim and adds the company as 'conflict'", async () => {
    await ingest([
      await chClaim(runId, {
        field: "employees_average",
        value: 12,
        published: "2026-01-01T00:00:00Z",
        source: "company_website",
        tier: 3,
        fetched: NOW,
      }),
      await chClaim(runId, {
        field: "employees_average",
        value: 30,
        published: "2026-02-01T00:00:00Z",
        source: "test_vendor",
        tier: 3,
        fetched: NOW,
      }),
    ]);
    expect((await storage.facts.getCurrent("01234567", "employees_average"))?.status).toBe(
      "conflict",
    );
    await resolveConflict(storage, ctx, "01234567", "employees_average", 12);
    expect((await storage.facts.getCurrent("01234567", "employees_average"))?.status).toBe(
      "verified",
    );
    expect((await storage.golden.list())[0]?.reason).toBe("conflict");
  });

  it("accuracy per source/field and calibration of the facts we'd have served", async () => {
    for (let i = 0; i < 10; i++) {
      const id = String(40_000_000 + i);
      await ingest([
        await chClaim(runId, {
          entity: id,
          field: "employees_average",
          value: 20,
          published: "2026-01-01T00:00:00Z",
          source: "companies_house_accounts",
          fetched: NOW,
        }),
      ]);
      await recordGolden(storage, ctx, id, { employees_average: i < 8 ? 21 : 40 }); // 8 within ±10%, 2 wrong
    }
    const r = await accuracyReport(storage, ctx);
    expect(r.golden_companies).toBe(10);
    expect(r.accuracy).toEqual([
      {
        source: "companies_house_accounts",
        field: "employees_average",
        n: 10,
        correct: 8,
        accuracy: 0.8,
      },
    ]);
    const all = r.calibration.find((b) => b.field === "all");
    expect(all?.n).toBe(10);
    expect(all?.accuracy).toBeCloseTo(0.8, 12);
    expect(r.brier).toBeGreaterThan(0);
  });
});

describe("drift monitoring", () => {
  const cfg = () => ctx.verification.drift;
  const row = (o: Partial<Parameters<typeof compareToBaseline>[0]> = {}) => ({
    day: today,
    source: "s",
    field: "f",
    volume: 100,
    null_rate: 0.05,
    mean: 10,
    top_share: null,
    match_rate: 0.99,
    ...o,
  });

  it("flags volume, empty-value, match-rate and average shifts against the baseline", () => {
    const hist = [row(), row(), row(), row()];
    expect(compareToBaseline(row(), hist, cfg())).toEqual([]);
    expect(compareToBaseline(row({ volume: 20 }), hist, cfg())[0]).toMatch(/volume/);
    expect(compareToBaseline(row({ null_rate: 0.5 }), hist, cfg())[0]).toMatch(/empty values/);
    expect(compareToBaseline(row({ match_rate: 0.7 }), hist, cfg())[0]).toMatch(/match rate/);
    expect(compareToBaseline(row({ mean: 30 }), hist, cfg())[0]).toMatch(/average/);
    expect(compareToBaseline(row({ volume: 1 }), hist.slice(0, 2), cfg())).toEqual([]); // not enough baseline yet
  });

  const websiteClaim = () =>
    chClaim(runId, {
      field: "website_copyright_year",
      value: 2015,
      published: NOW,
      source: "company_website",
      tier: 3,
      fetched: NOW,
    });
  /** Two earlier complete runs that re-fetched the same claim (so the source has 3 in total). */
  const twoEarlierRuns = async () => {
    for (const d of [10, 9]) {
      const r = await storage.runs.start({ kind: "earlier" });
      await storage.claims.record([await websiteClaim()], {
        run_id: r.run_id,
        fetched_at: new Date(Date.now() - d * 86_400_000).toISOString(),
      });
      await storage.runs.finish(r.run_id, "succeeded");
    }
  };
  const baseline = async () => {
    for (let d = 1; d <= 4; d++) {
      const day = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      await storage.drift.put([
        {
          day,
          source: "company_website",
          field: "website_copyright_year",
          volume: 100,
          null_rate: 0,
          mean: 2015,
          top_share: null,
          match_rate: 1,
        },
      ]);
    }
  };

  it("only complete runs count: a still-running or partial run is ignored", async () => {
    await ingest([await websiteClaim()]);
    expect(await computeDrift(storage, today)).toEqual([]); // run still running
    await storage.runs.markPartial(runId);
    await storage.runs.finish(runId, "succeeded");
    expect(await computeDrift(storage, today)).toEqual([]); // partial (resumed / limited)
  });

  it("a source isn't judged until it has 3 complete runs", async () => {
    await ingest([await websiteClaim()]);
    await storage.runs.finish(runId, "succeeded");
    await baseline();
    const r = await runDriftCheck(storage, ctx, today);
    expect(r.breaches).toEqual([]);
    expect(r.not_evaluated).toEqual([{ source: "company_website", complete_runs: 1 }]);
  });

  it("a breach pauses the source; its facts become quarantined, not verified", async () => {
    await ingest([await websiteClaim()]);
    await storage.runs.finish(runId, "succeeded");
    await twoEarlierRuns();
    const m = await computeDrift(storage, today);
    expect(m.find((x) => x.source === "company_website")?.volume).toBe(1);
    // A baseline of 4 days at volume 100 makes today's 1 a breach.
    for (let d = 1; d <= 4; d++) {
      const day = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      await storage.drift.put([
        {
          day,
          source: "company_website",
          field: "website_copyright_year",
          volume: 100,
          null_rate: 0,
          mean: 2015,
          top_share: null,
          match_rate: 1,
        },
      ]);
    }
    const r = await runDriftCheck(storage, ctx, today);
    expect(r.breaches.map((b) => b.source)).toEqual(["company_website"]);
    expect((await storage.alerts.list({ limit: 5 }))[0]?.kind).toBe("drift");
    const q = (caller: "dashboard" | "opportunity") =>
      getVerifiedFacts(storage, ctx, {
        entities: ["01234567"],
        fields: ["website_copyright_year"],
        minConfidence: 0,
        asOf: NOW,
        lanes: ["open"],
        caller,
      });
    expect((await q("dashboard"))[0]?.status).toBe("quarantined");
    expect(await q("opportunity")).toEqual([]);
    await resumeSource(storage, "company_website", "website_copyright_year");
    expect((await q("opportunity"))[0]?.status).toBe("verified");
    // Resuming closes the drift alert too: Alerts and Paused sources agree.
    expect(
      (await storage.alerts.list({ unacknowledged: true, limit: 10 })).filter(
        (a) => a.kind === "drift",
      ),
    ).toEqual([]);
  });
});
