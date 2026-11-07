import { describe, expect, it } from "vitest";
import {
  costGbp,
  FakeEmailSender,
  FakeModel,
  FakeWebFetcher,
  htmlToText,
  InMemoryQueue,
} from "./index.ts";

describe("ports and fakes", () => {
  it("fake model is deterministic and reports usage", async () => {
    const m = new FakeModel({ echo: (r) => r.user.toUpperCase() });
    const req = {
      prompt_id: "echo",
      prompt_version: 1,
      role: "writer" as const,
      system: "s",
      user: "hello",
      max_tokens: 10,
    };
    const a = await m.complete(req);
    expect(a.text).toBe("HELLO");
    expect(a).toEqual(await m.complete(req));
    expect(a.usage.output_tokens).toBe(2);
    await expect(m.complete({ ...req, prompt_id: "nope" })).rejects.toThrow(/no handler/);
  });

  it("costs tokens in GBP", () => {
    expect(
      costGbp(
        { input_tokens: 1_000_000, output_tokens: 100_000 },
        { input_usd_per_mtok: 4, output_usd_per_mtok: 20 },
        0.8,
      ),
    ).toBeCloseTo(4.8, 12);
  });

  it("strips HTML to text without scripts", () => {
    expect(htmlToText("<p>Hi <b>there</b></p><script>evil()</script><p>&copy; 2019</p>")).toBe(
      "Hi there\n© 2019",
    );
  });

  it("fake web fetcher, email sender and queue record everything", async () => {
    const f = new FakeWebFetcher(
      new Map([["https://a.example/", { body: "x" }]]),
      () => "2026-01-01T00:00:00Z",
    );
    expect((await f.fetch("https://a.example/")).status).toBe(200);
    expect((await f.fetch("https://b.example/")).status).toBe(404);
    const e = new FakeEmailSender();
    expect(
      (await e.send({ to: "a@b.c", from: "x@y.z", subject: "s", body: "b" }, true)).delivered,
    ).toBe(false);
    const q = new InMemoryQueue();
    await q.send("q", 1);
    await q.send("q", 2);
    expect(await q.receive("q", 1)).toEqual([1]);
    expect(await q.receive("q", 5)).toEqual([2]);
  });
});
