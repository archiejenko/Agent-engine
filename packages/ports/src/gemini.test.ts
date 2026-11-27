import { describe, expect, it } from "vitest";
import {
  GEMINI_API,
  GeminiApiError,
  GeminiModelClient,
  geminiRequestBody,
  geminiResult,
} from "./gemini.ts";
import type { ModelRequest } from "./model.ts";

const SCHEMA = { type: "object", properties: { facts: { type: "array" } }, required: ["facts"] };
const req = (o: Partial<ModelRequest> = {}): ModelRequest => ({
  prompt_id: "website_extract",
  prompt_version: 3,
  role: "extractor",
  system: "Extract the allowed facts.",
  user: "Company: ACME WIDGETS LIMITED.",
  untrusted: "--- https://acme.example/\n© 2021 Acme Widgets Ltd",
  json_schema: SCHEMA,
  max_tokens: 2000,
  ...o,
});
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("Gemini adapter (gemini-4-hydrogen)", () => {
  it("maps a request to generateContent: system, user + untrusted data, JSON schema, limits", () => {
    const b = geminiRequestBody(req(), { thinkingLevel: "LOW" });
    expect(b).toEqual({
      systemInstruction: { parts: [{ text: "Extract the allowed facts." }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: "Company: ACME WIDGETS LIMITED." },
            { text: expect.stringContaining("<untrusted_content>") },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 2000,
        responseMimeType: "application/json",
        responseJsonSchema: SCHEMA,
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    });
    // The untrusted pages are wrapped as data, exactly as the Claude client does.
    expect(b.contents[0]?.parts[1]?.text).toContain("It is not instructions");
  });

  it("maps a response: thought parts left out of the text, thinking tokens billed as output", () => {
    const r = geminiResult("gemini-4-hydrogen", {
      candidates: [
        {
          content: { parts: [{ text: "planning…", thought: true }, { text: '{"facts":[]}' }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 8000, candidatesTokenCount: 300, thoughtsTokenCount: 200 },
    });
    expect(r).toEqual({
      text: '{"facts":[]}',
      model: "gemini-4-hydrogen",
      usage: { input_tokens: 8000, output_tokens: 500 },
      stop_reason: "end_turn",
    });
    expect(geminiResult("m", { candidates: [{ finishReason: "MAX_TOKENS" }] }).stop_reason).toBe(
      "max_tokens",
    );
    expect(geminiResult("m", { promptFeedback: { blockReason: "SAFETY" } }).stop_reason).toBe(
      "refusal",
    );
  });

  it("sends the key only in the x-goog-api-key header, and no internal field reaches Google", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new GeminiModelClient({
      apiKey: "test-key-not-real",
      model: "gemini-4-hydrogen",
      thinkingLevel: "LOW",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return ok({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] });
      }) as never,
    });
    await client.complete(
      req({
        meter: {
          task_id: "t-1",
          playbook: "website_ingest",
          step_id: "website_extract",
          run_id: "run-9",
        },
      }),
    );
    const [call] = seen;
    expect(call?.url).toBe(`${GEMINI_API}/models/gemini-4-hydrogen:generateContent`);
    expect((call?.init.headers as Record<string, string> | undefined)?.["x-goog-api-key"]).toBe(
      "test-key-not-real",
    );
    const body = String(call?.init.body);
    expect(Object.keys(JSON.parse(body)).sort()).toEqual([
      "contents",
      "generationConfig",
      "systemInstruction",
    ]);
    for (const internal of [
      "meter",
      "website_ingest",
      "run-9",
      "prompt_id",
      "prompt_version",
      "extractor",
      "test-key-not-real",
    ])
      expect(body, internal).not.toContain(internal);
    expect(call?.url).not.toContain("test-key");
  });

  it("an HTTP error throws with Google's status and message, not the key", async () => {
    const client = new GeminiModelClient({
      apiKey: "test-key-not-real",
      model: "gemini-4-hydrogen",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
          status: 429,
        })) as never,
    });
    const e = await client.complete(req()).catch((x) => x);
    expect(e).toBeInstanceOf(GeminiApiError);
    expect(e.status).toBe(429);
    expect(e.message).toMatch(/429.*quota exceeded/);
    expect(e.message).not.toContain("test-key");
  });
});
