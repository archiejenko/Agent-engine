import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

/**
 * Cockpit U3: dashboard buttons that start something (raise a tier, promote, pin or kill a Board tile,
 * record a pool top-up) first open a decision, then resolve it through /api/decisions/:id/decide.
 */
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/decisions/request", () => {
  it("opens a decision but approves nothing; only /decide records the choice", async () => {
    const s = await openSqliteStorage(":memory:");
    const app = createApp({ runtime: "node", storage: () => s });
    const before = (await s.ownerApprovals.list(100)).length;
    const r = await post(app, "/api/decisions/request", {
      kind: "spend_tier",
      playbook: "sme_outreach",
      tier: "S1",
    });
    expect(r.status).toBe(201);
    const { decision_id, option } = (await r.json()) as { decision_id: string; option: string };
    expect(option).toBe("raise");
    const x = await s.decisions.get(decision_id);
    expect(x).toMatchObject({ status: "open", type: "spend_tier", safe_default: "keep" });
    expect((await s.ownerApprovals.list(100)).length).toBe(before);

    const d = await post(app, `/api/decisions/${decision_id}/decide`, { option });
    expect(d.status).toBe(200);
    expect((await s.decisions.get(decision_id))?.status).toBe("decided");
    expect((await s.ownerApprovals.list(100)).length).toBe(before + 1);
  });

  it("a pool top-up is recorded only after /decide, with Archie's approval on it", async () => {
    const s = await openSqliteStorage(":memory:");
    const app = createApp({ runtime: "node", storage: () => s });
    const r = await post(app, "/api/decisions/request", {
      kind: "pool_topup",
      amount_gbp: 25,
      note: "card",
    });
    const { decision_id } = (await r.json()) as { decision_id: string };
    expect(await s.poolEvents.list()).toEqual([]);
    expect((await s.decisions.get(decision_id))?.safe_default).toBe("cancel");
    await post(app, `/api/decisions/${decision_id}/decide`, { option: "record" });
    const [e] = await s.poolEvents.list();
    expect(e).toMatchObject({ kind: "topup", amount_gbp: 25, note: "card" });
    expect(e?.approval_id).toBe((await s.decisions.get(decision_id))?.approval_id);
    // Runway now has its top-up: no more "record a top-up" note.
    const rw = (await (await app.request("/api/panels/runway")).json()) as { note: string };
    expect(rw.note).not.toMatch(/record a top-up/);
  });

  it("refuses bad requests and unknown targets", async () => {
    const s = await openSqliteStorage(":memory:");
    const app = createApp({ runtime: "node", storage: () => s });
    expect(
      (await post(app, "/api/decisions/request", { kind: "pool_topup", amount_gbp: -5 })).status,
    ).toBe(400);
    expect((await post(app, "/api/decisions/request", { kind: "nuke" })).status).toBe(400);
    expect(
      (
        await post(app, "/api/decisions/request", {
          kind: "autonomy",
          playbook: "no_such_playbook",
        })
      ).status,
    ).toBe(404);
    expect(
      (await post(app, "/api/decisions/request", { kind: "board", key: "nope", action: "kill" }))
        .status,
    ).toBe(404);
  });
});
