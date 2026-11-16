import { loadInfraConfig } from "@ae/config";
import { InMemoryQueue, signStripePayload, toSubscriptionEvent } from "@ae/ports";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { checkSiteDraft } from "../claim.ts";
import { K } from "../controls.ts";
import { loadBundledPlaybooks } from "../playbook.ts";
import { checkReply, triageReply } from "../playbooks/post_reply.ts";
import { createTask } from "../tasks.ts";
import { ToolBlockedError, ToolRegistry } from "../tools.ts";

let storage: Storage;
beforeEach(async () => {
  storage = await openSqliteStorage(":memory:");
});

describe("post_reply", () => {
  it("triage is deterministic, complaints first", () => {
    expect(triageReply("This is spam, how did you get my email? Yes interested")).toBe("complaint");
    expect(triageReply("Not now thanks, maybe next year")).toBe("not_now");
    expect(triageReply("How much would it cost?")).toBe("price");
    expect(triageReply("Yes, sounds good")).toBe("interested");
    expect(triageReply("Do you do e-commerce?")).toBe("question");
  });
  it("reply rules: no prices, no placeholders, no disguise, no sales after a complaint", () => {
    expect(checkReply({ subject: "Re", body: "It's £499 all in." }, "price").join()).toMatch(
      /price/,
    );
    expect(checkReply({ subject: "Re", body: "Hi [NAME]" }, "question").join()).toMatch(
      /placeholder/,
    );
    expect(checkReply({ subject: "Re", body: "Just a personal note." }, "question").join()).toMatch(
      /presents itself/,
    );
    expect(checkReply({ subject: "Re", body: "Sorry. Fancy a call?" }, "complaint").join()).toMatch(
      /complaint/,
    );
    expect(
      checkReply({ subject: "Re", body: "Thanks, would a short call help?" }, "interested"),
    ).toEqual([]);
  });
});

describe("claim this site", () => {
  it("the site draft may only use what the customer sent", () => {
    const details = { business_description: "Boiler repairs, central heating", area: "Stockport" };
    expect(
      checkSiteDraft(
        { headline: "Boiler repairs", about: "Based in Stockport", services: ["Boiler repairs"] },
        details,
      ),
    ).toEqual([]);
    const bad = checkSiteDraft(
      { headline: "Since 1998", about: "Award-winning", services: ["Roofing"] },
      details,
    );
    expect(bad.join()).toMatch(/Roofing/);
    expect(bad.join()).toMatch(/1998/);
  });

  it("maps Stripe subscription events to provider-neutral ones (UNVERIFIED field names)", async () => {
    const body = JSON.stringify({
      id: "evt_1",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          subscription: "sub_1",
          amount_paid: 1500,
          currency: "gbp",
          billing_reason: "subscription_cycle",
        },
      },
    });
    expect(toSubscriptionEvent(body)).toMatchObject({
      kind: "invoice_paid",
      amount_gbp: 15,
      first_invoice: false,
    });
    expect(
      toSubscriptionEvent(
        JSON.stringify({ id: "e", type: "customer.created", data: { object: {} } }),
      ),
    ).toBeNull();
    expect(await signStripePayload(body, "s")).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("a tool that refuses before acting is recorded as 'didn't happen', so a later retry may run", async () => {
    const cfg = loadInfraConfig();
    await storage.controls.set(K.global, false, "test");
    const reg = new ToolRegistry(storage, cfg);
    let refuse = true;
    let ran = 0;
    reg.register(
      {
        name: "ext",
        description: "x",
        allowed_lanes: ["open"],
        external: true,
        serves_customer: true,
        allowed_roles: ["operator"],
        rate_limit_per_min: 100,
        cost_gbp_per_call: 0,
      },
      async () => {
        if (refuse) throw new ToolBlockedError("ext", "not configured yet");
        ran++;
        return { result: "ok" };
      },
    );
    const { task } = await createTask(
      storage,
      cfg,
      await loadBundledPlaybooks(),
      new InMemoryQueue(),
      {
        idempotency_key: "t",
        playbook: "sme_outreach",
        revenue_path: "sme_outreach",
        source_ref: "x:entity:01234567",
        lane: "open",
      },
    );
    const ctx = { task, role: "operator" as const, step_tools: ["ext"] };
    await expect(reg.call("ext", { a: 1 }, ctx)).rejects.toThrow("not configured");
    expect((await storage.effects.forTask(task.task_id))[0]?.status).toBe("not_happened");
    refuse = false;
    await reg.call("ext", { a: 1 }, ctx);
    await reg.call("ext", { a: 1 }, ctx); // a repeat returns the recorded result
    expect(ran).toBe(1);
  });
});
