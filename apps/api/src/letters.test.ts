import { loadInfraConfig } from "@ae/config";
import { K, letterSuppressionKey, processInbox } from "@ae/infra";
import { FakeInbox } from "@ae/ports";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

let storage: Storage;
const app = () => createApp({ runtime: "node", storage: () => storage });

beforeEach(async () => {
  storage = await openSqliteStorage(":memory:");
  await storage.demoPages.put({
    slug: "demo123",
    entity_id: "01234567",
    task_id: "t1",
    html: "<!doctype html><p>demo</p>",
  });
  await storage.letters.put({
    task_id: "t1",
    entity_id: "01234567",
    company_name: "ACME WIDGETS LTD",
    address: ["The Directors", "ACME WIDGETS LTD"],
    demo_slug: "demo123",
    opt_out_code: "LABC234",
    pdf_b64: "",
    flags: [],
  });
  await storage.controls.set(K.global, false, "test"); // external actions allowed for these tests
});

describe("demo pages", () => {
  it("are live after approval, with no external resources allowed, then expire after 30 days", async () => {
    expect((await app().request("/demo/demo123")).status).toBe(404); // not approved yet
    const days = loadInfraConfig().letters.demo_expiry_days;
    const at = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    await storage.demoPages.setPublished(["demo123"], true, at(days - 1));
    const live = await app().request("/demo/demo123");
    expect(live.status).toBe(200);
    expect(live.headers.get("content-security-policy")).toContain("img-src 'none'");
    expect(live.headers.get("x-robots-tag")).toContain("noindex");
    await storage.demoPages.setPublished(["demo123"], true, at(days + 1));
    const expired = await app().request("/demo/demo123");
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain("This sample has expired.");
  });
});

describe("letter opt-out", () => {
  it("short URL: GET only asks; POST adds the company to the shared suppression list", async () => {
    const page = await app().request("/stop/labc234");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Stop letters to ACME WIDGETS LTD?");
    expect(await storage.suppressions.isSuppressed(letterSuppressionKey("01234567"))).toBe(false);
    const done = await app().request("/stop/LABC234", { method: "POST" });
    expect(done.status).toBe(200);
    expect(await storage.suppressions.isSuppressed(letterSuppressionKey("01234567"))).toBe(true);
    expect((await app().request("/stop/LZZZZZZ", { method: "POST" })).status).toBe(404);
  });

  it("works even while the kill switch is on (opting out is never blocked)", async () => {
    await storage.controls.set(K.global, true, "test");
    expect((await app().request("/stop/LABC234", { method: "POST" })).status).toBe(200);
    expect(await storage.suppressions.isSuppressed(letterSuppressionKey("01234567"))).toBe(true);
  });

  it("an email quoting the printed code suppresses the company and the sender", async () => {
    const inbox = new FakeInbox();
    inbox.messages.push({
      id: "m1",
      from: "Director@Acme.example",
      to: "archie@example.invalid",
      subject: "Your letter",
      body: "Please stop writing to us. Ref labc234",
      received_at: new Date().toISOString(),
      in_reply_to: null,
    });
    const r = await processInbox(storage, loadInfraConfig(), inbox, "2000-01-01");
    expect(r.opt_outs).toBe(1);
    expect(await storage.suppressions.isSuppressed(letterSuppressionKey("01234567"))).toBe(true);
    expect(await storage.suppressions.isSuppressed("director@acme.example")).toBe(true);
  });
});
