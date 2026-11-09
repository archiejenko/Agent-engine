import { describe, expect, it } from "vitest";
import { AnthropicModelClient } from "./anthropic.ts";

/** Captures the request the adapter would send (no network, dummy key). */
async function bodyFor(model: string) {
  let body: Record<string, unknown> = {};
  let beta = "";
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    beta = new Headers(init.headers).get("anthropic-beta") ?? "";
    return Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  }) as unknown as typeof fetch;
  const roles = { extractor: { model, effort: "low" as const } } as never;
  const client = new AnthropicModelClient(roles, { apiKey: "test-dummy", fetch: fakeFetch });
  const res = await client.complete({
    prompt_id: "website_extract",
    prompt_version: 1,
    role: "extractor",
    system: "s",
    user: "u",
    max_tokens: 100,
  });
  return { body, beta, res };
}

describe("Claude adapter request shape", () => {
  it("asks for server-side refusal fallbacks on Opus 5.5 and Sonnet 5.5", async () => {
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      const { body, beta } = await bodyFor(m);
      expect(body.fallbacks).toBe("default");
      expect(beta).toContain("server-side-fallback-2026-07-01");
    }
  });
  it("doesn't send fallbacks to Haiku 5.5 (it has none), so switching extraction to Haiku works", async () => {
    const { body, beta, res } = await bodyFor("claude-haiku-5-5");
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.fallbacks).toBeUndefined();
    expect(beta).not.toContain("server-side-fallback");
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
  });
});
