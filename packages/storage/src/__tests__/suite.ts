import type { Claim, VerifiedFact } from "@ae/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlDriver } from "../driver.ts";
import { migrate } from "../migrate.ts";
import { loadMigrations } from "../migrations-fs.ts";
import { SqlStorage } from "../sql-storage.ts";

export interface Harness {
  driver: SqlDriver;
  dispose(): Promise<void>;
}

/** The same behaviour is required of every adapter. Run this suite once per adapter. */
export function storageSuite(adapter: string, makeHarness: () => Promise<Harness>) {
  describe(`Storage contract on ${adapter}`, () => {
    let h: Harness;
    let s: SqlStorage;
    let runId: string;

    const claim = (overrides: Partial<Claim> = {}): Claim => ({
      claim_id: crypto.randomUUID(),
      entity_id: "01234567",
      raw_entity_ref: { source_id: "01234567", name: "ACME WIDGETS LTD" },
      field: "company_status",
      value: "active",
      source: "companies_house",
      source_tier: 1,
      lane: "open",
      method: "api",
      evidence: {
        kind: "record",
        ref: "https://api.company-information.service.gov.uk/company/01234567",
      },
      observed_at: "2026-10-01T00:00:00Z",
      published_at: "2026-10-02T00:00:00Z",
      fetched_at: "2026-11-07T09:00:00Z",
      run_id: runId,
      ...overrides,
    });

    const fact = (supporting: string[], overrides: Partial<VerifiedFact> = {}): VerifiedFact => ({
      entity_id: "01234567",
      field: "company_status",
      value: "active",
      confidence: 0.9,
      supporting_claims: supporting,
      conflicting_claims: [],
      lane: "open",
      valid_from: "2026-10-02T00:00:00Z",
      first_observed_at: "2026-10-01T00:00:00Z",
      last_verified_at: "2026-11-07T09:00:00Z",
      expires_at: null,
      status: "verified",
      ...overrides,
    });

    beforeEach(async () => {
      h = await makeHarness();
      const applied = await migrate(h.driver, loadMigrations());
      expect(applied).toContain("0001_core.sql");
      s = new SqlStorage(h.driver);
      runId = (await s.runs.start({ kind: "test", config_versions: { universe: "v1" } })).run_id;
    });

    afterEach(async () => {
      await h.dispose();
    });

    it("migrations apply from empty and re-running is a no-op", async () => {
      expect(await migrate(h.driver, loadMigrations())).toEqual([]);
      expect(await s.health()).toEqual({ ok: true, migrations: loadMigrations().length });
    });

    it("records runs with config versions", async () => {
      const run = await s.runs.get(runId);
      expect(run?.status).toBe("running");
      expect(run?.config_versions).toEqual({ universe: "v1" });
      await s.runs.finish(runId, "succeeded");
      expect((await s.runs.get(runId))?.status).toBe("succeeded");
    });

    it("round-trips claims exactly, including JSON values and evidence", async () => {
      const c = claim({ field: "sic_codes", value: ["62012", "62020"] });
      await s.claims.insertMany([c]);
      expect(await s.claims.get(c.claim_id)).toEqual(c);
      expect(await s.claims.listByRun(runId)).toEqual([c]);
    });

    it("validates claims against the contract before writing", async () => {
      const bad = claim({ method: "llm_extract", evidence: null });
      await expect(s.claims.insertMany([bad])).rejects.toThrow();
      expect(await s.claims.listByRun(runId)).toEqual([]);
    });

    it("insertMany is atomic: one bad row writes nothing", async () => {
      const good = claim();
      const dupe = { ...claim(), claim_id: good.claim_id };
      await expect(s.claims.insertMany([good, dupe])).rejects.toThrow();
      expect(await s.claims.listByRun(runId)).toEqual([]);
    });

    it("claims are append-only: the database refuses UPDATE and DELETE", async () => {
      const c = claim();
      await s.claims.insertMany([c]);
      await expect(
        h.driver.run("UPDATE claims SET value = ? WHERE claim_id = ?", ['"dissolved"', c.claim_id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        h.driver.run("DELETE FROM claims WHERE claim_id = ?", [c.claim_id]),
      ).rejects.toThrow(/append-only/);
      expect((await s.claims.get(c.claim_id))?.value).toBe("active");
    });

    it("supersedes claims without deleting them", async () => {
      const c = claim();
      await s.claims.insertMany([c]);
      await s.claims.supersede([c.claim_id], "rolled back", null);
      expect(await s.claims.isSuperseded(c.claim_id)).toBe(true);
      expect(await s.claims.get(c.claim_id)).toEqual(c);
    });

    it("keeps every version of a fact and serves the latest as current", async () => {
      const c1 = claim();
      const c2 = claim({ value: "liquidation", published_at: "2026-11-01T00:00:00Z" });
      await s.claims.insertMany([c1, c2]);

      const v1 = await s.facts.put(fact([c1.claim_id]), {
        run_id: runId,
        recorded_at: "2026-11-07T09:00:00Z",
      });
      const v2 = await s.facts.put(
        fact([c2.claim_id], { value: "liquidation", valid_from: "2026-11-01T00:00:00Z" }),
        { run_id: runId, recorded_at: "2026-11-07T10:00:00Z" },
      );
      expect([v1, v2]).toEqual([1, 2]);

      expect((await s.facts.getCurrent("01234567", "company_status"))?.value).toBe("liquidation");
      const versions = await s.facts.listVersions("01234567", "company_status");
      expect(versions.map((v) => [v.version, v.fact.value, v.recorded_at])).toEqual([
        [1, "active", "2026-11-07T09:00:00Z"],
        [2, "liquidation", "2026-11-07T10:00:00Z"],
      ]);
      expect(await s.facts.countCurrent()).toBe(1);
    });

    it("validates facts against the contract before writing", async () => {
      await expect(
        s.facts.put(fact([], {}), { run_id: runId, recorded_at: "2026-11-07T09:00:00Z" }),
      ).rejects.toThrow();
      expect(await s.facts.countCurrent()).toBe(0);
    });

    it("record(): re-fetching a claim adds an observation, not a duplicate", async () => {
      const c = claim();
      expect(await s.claims.record([c], { run_id: runId, fetched_at: c.fetched_at })).toEqual({
        inserted: 1,
      });
      const run2 = (await s.runs.start({ kind: "refetch" })).run_id;
      expect(
        await s.claims.record([c], { run_id: run2, fetched_at: "2026-11-14T09:00:00Z" }),
      ).toEqual({
        inserted: 0,
      });
      const usable = await s.claims.listUsable("01234567", "company_status");
      expect(usable).toHaveLength(1);
      expect(usable[0]?.observations).toEqual(["2026-11-07T09:00:00Z", "2026-11-14T09:00:00Z"]);
      expect(await s.claims.touchedByRun(run2)).toEqual([
        { entity_id: "01234567", field: "company_status" },
      ]);
    });

    it("listUsable excludes superseded, rejected and rolled-back claims", async () => {
      const keep = claim();
      const superseded = claim();
      const rejected = claim();
      await s.claims.insertMany([keep, superseded, rejected]);
      await s.claims.supersede([superseded.claim_id], "test", null);
      await s.claims.reject([{ claim_id: rejected.claim_id, rule: "test_rule", detail: "x" }]);
      const run2 = (await s.runs.start({ kind: "bad" })).run_id;
      const fromBadRun = claim({ run_id: run2 });
      await s.claims.insertMany([fromBadRun]);
      await s.runs.finish(run2, "rolled_back");
      const ids = (await s.claims.listUsable("01234567", "company_status")).map(
        (u) => u.claim.claim_id,
      );
      expect(ids).toEqual([keep.claim_id]);
      expect(await s.claims.listRejections(10)).toEqual([
        { claim_id: rejected.claim_id, rule: "test_rule", detail: "x" },
      ]);
    });

    it("listVersionsFor hides versions written by rolled-back runs", async () => {
      const c = claim();
      await s.claims.insertMany([c]);
      await s.facts.put(fact([c.claim_id]), { run_id: runId, recorded_at: "2026-11-07T09:00:00Z" });
      const bad = (await s.runs.start({ kind: "bad" })).run_id;
      await s.facts.put(fact([c.claim_id], { value: "dissolved" }), {
        run_id: bad,
        recorded_at: "2026-11-08T09:00:00Z",
      });
      await s.runs.finish(bad, "rolled_back");
      const versions = await s.facts.listVersionsFor(["01234567"], ["company_status"]);
      expect(versions.map((v) => v.fact.value)).toEqual(["active"]);
      expect((await s.facts.listVersionsFor(null, ["company_status"])).length).toBe(1);
    });

    it("touch updates the current row without a new version; removeCurrent keeps history", async () => {
      const c = claim();
      await s.claims.insertMany([c]);
      await s.facts.put(fact([c.claim_id]), { run_id: runId, recorded_at: "2026-11-07T09:00:00Z" });
      await s.facts.touch("01234567", "company_status", {
        last_verified_at: "2026-11-14T09:00:00Z",
        confidence: 0.95,
        expires_at: "2026-11-21T09:00:00Z",
        status: "verified",
      });
      expect((await s.facts.getCurrent("01234567", "company_status"))?.last_verified_at).toBe(
        "2026-11-14T09:00:00Z",
      );
      expect(await s.facts.listVersions("01234567", "company_status")).toHaveLength(1);
      expect(await s.facts.countByStatus()).toEqual({ verified: 1 });
      await s.facts.removeCurrent("01234567", "company_status");
      expect(await s.facts.getCurrent("01234567", "company_status")).toBeNull();
      expect(await s.facts.listVersions("01234567", "company_status")).toHaveLength(1);
    });

    it("stores entities, universe decisions, progress and verification requests", async () => {
      const e = {
        entity_id: "01234567",
        name: "ACME WIDGETS LTD",
        name_normalised: "ACME WIDGETS",
        postcode: "M1 1AA",
        lad_code: "E08000003",
        company_status: "active",
        accounts_category: "MICRO ENTITY",
        sic_codes: ["62012"],
        charges_count: 0,
        incorporation_date: "2015-03-01",
      };
      await s.entities.upsertMany(
        [e, { ...e, entity_id: "07654321", name_normalised: "OTHER", postcode: "BL1 1AA" }],
        runId,
      );
      expect(await s.entities.get("01234567")).toEqual(e);
      expect(await s.entities.count()).toBe(2);
      expect(
        (await s.entities.findCandidates({ nameNormalised: "ACME WIDGETS", limit: 5 })).map(
          (x) => x.entity_id,
        ),
      ).toEqual(["01234567"]);
      expect(
        (await s.entities.findCandidates({ postcode: "BL1 1AA", limit: 5 })).map(
          (x) => x.entity_id,
        ),
      ).toEqual(["07654321"]);

      await s.universe.setMany(
        [
          {
            universe: "u",
            entity_id: "01234567",
            included: true,
            reason: "in",
            staff_flag: "staff_unknown",
          },
          {
            universe: "u",
            entity_id: "07654321",
            included: false,
            reason: "sic_excluded",
            staff_flag: "not_checked",
          },
        ],
        runId,
      );
      expect(await s.universe.counts("u")).toEqual({ included: 1, excluded: 1, staff_unknown: 1 });
      expect((await s.universe.list("u", { included: true })).map((m) => m.entity_id)).toEqual([
        "01234567",
      ]);

      await s.progress.ensure("job", ["01234567", "07654321"], ["profile"]);
      await s.progress.ensure("job", ["01234567"], ["profile"]); // idempotent
      await s.progress.mark("job", "01234567", "profile", "done");
      await s.progress.mark("job", "07654321", "profile", "failed", "HTTP 500");
      expect(await s.progress.summary("job")).toEqual({
        pending: 0,
        done: 1,
        failed: 1,
        skipped: 0,
      });
      expect(await s.progress.next("job", 10, 3)).toEqual([
        { entity_id: "07654321", step: "profile", attempts: 1 },
      ]);
      expect(await s.progress.next("job", 10, 1)).toEqual([]);

      await s.verificationRequests.add([
        { entity_id: "01234567", field: "officers_active", reason: "outreach", deadline: null },
      ]);
      expect((await s.verificationRequests.listOpen(5)).map((r) => r.field)).toEqual([
        "officers_active",
      ]);

      expect(await s.stats.universeReasons("u")).toEqual({ in: 1, sic_excluded: 1 });
      expect(await s.stats.unanchoredMembers("u")).toEqual(["01234567"]);
      expect((await s.stats.counts()).entities).toBe(2);

      await s.dropped.record("companies_house", "mystery_field", runId, 2);
      await s.dropped.record("companies_house", "mystery_field", runId, 3);
      expect(await s.dropped.list(runId)).toEqual([
        { source: "companies_house", source_field: "mystery_field", run_id: runId, occurrences: 5 },
      ]);
    });

    it("phase 2: tasks are idempotent; run log sums spend; approvals, examples, controls, alerts, quarantine", async () => {
      const task = {
        task_id: crypto.randomUUID(),
        idempotency_key: "opp:1",
        playbook: "sme_outreach",
        playbook_version: 1,
        revenue_path: "sme_outreach" as const,
        source_ref: "opportunity:1",
        lane: "open" as const,
        autonomy: "L0" as const,
        status: "queued" as const,
        budget_gbp: 0.4,
        revenue_gbp: 0,
        cost_gbp: 0,
        priority: "outreach",
      };
      const a = await s.tasks.insertIdempotent(task);
      const b = await s.tasks.insertIdempotent({ ...task, task_id: crypto.randomUUID() });
      expect(b.task_id).toBe(a.task_id); // same key → same task
      await s.tasks.update(a.task_id, { status: "running", state: { step: "draft" } });
      await s.tasks.addCost(a.task_id, 0.05);
      const t = await s.tasks.get(a.task_id);
      expect(t?.status).toBe("running");
      expect(t?.state).toEqual({ step: "draft" });
      expect(t?.cost_gbp).toBeCloseTo(0.05, 12);

      await s.runLog.append({
        task_id: a.task_id,
        step_id: "draft",
        role: "writer",
        model: "fake-model",
        tool_calls: [],
        output: { text: "hi" },
        check_result: null,
        tokens: { input: 10, output: 5 },
        cost_gbp: 0.05,
        duration_ms: 12,
        timestamp: "2026-11-08T10:00:00Z",
      });
      expect(await s.runLog.spendSince("2026-11-08T00:00:00Z")).toBeCloseTo(0.05, 12);
      expect(await s.runLog.spendSince("2026-11-08T00:00:00Z", "other")).toBe(0);
      expect((await s.runLog.forTask(a.task_id))[0]?.output).toEqual({ text: "hi" });

      await s.approvals.add({
        task_id: a.task_id,
        step_id: "approve",
        item_shown: { d: 1 },
        decision: "edit",
        edited_text: "better",
      });
      expect((await s.approvals.forTask(a.task_id))[0]?.edited_text).toBe("better");
      await s.examples.add({
        playbook: "sme_outreach",
        step_id: "draft",
        task_id: a.task_id,
        original: "x",
        edited: "better",
      });
      expect(await s.examples.list("sme_outreach", "draft", 5)).toEqual([
        { original: "x", edited: "better", task_id: a.task_id },
      ]);

      expect(await s.controls.get("kill:global")).toBeNull();
      await s.controls.set("kill:global", true, "test");
      expect(await s.controls.get<boolean>("kill:global")).toBe(true);
      await s.alerts.raise("spend_cap", "Daily cap hit", { cap: 5 });
      const [alert] = await s.alerts.list({ unacknowledged: true, limit: 5 });
      expect(alert?.kind).toBe("spend_cap");
      await s.alerts.acknowledge(alert?.id as number);
      expect(await s.alerts.list({ unacknowledged: true, limit: 5 })).toEqual([]);

      const qid = await s.quarantine.add({
        source: "company_website",
        raw_ref: "https://x",
        record: {},
        candidates: [],
        reason: "low score",
      });
      expect((await s.quarantine.listOpen(5)).map((q) => q.id)).toEqual([qid]);
      await s.quarantine.resolve(qid, null);
      expect(await s.quarantine.listOpen(5)).toEqual([]);
    });

    it("returns null for unknown rows", async () => {
      expect(await s.claims.get(crypto.randomUUID())).toBeNull();
      expect(await s.facts.getCurrent("99999999", "company_status")).toBeNull();
      expect(await s.runs.get(crypto.randomUUID())).toBeNull();
    });
  });
}
