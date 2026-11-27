import type { ModelsConfig } from "@ae/config";
import type { ModelClient } from "@ae/ports";
import { AnthropicModelClient } from "@ae/ports/anthropic";
import { GeminiModelClient } from "@ae/ports/gemini";

/**
 * The website extractor's models, from `models.json → website_extractor` (2026-11-27). Claude by
 * default; with `model: "gemini-4-hydrogen"`, Gemini first and the Claude fallback for any page where
 * Gemini errors or returns invalid JSON twice. Agents never come through here: they keep their own
 * Claude client. Keys are passed in by the caller (read through the key ring, rule 20), never read here.
 */
export function websiteExtractorModels(
  models: ModelsConfig,
  keys: { anthropic: string | null; gemini: string | null },
  o: { fetch?: typeof fetch } = {},
): { model: ModelClient; fallbackModel?: ModelClient } {
  const w = models.website_extractor;
  const claude = (model: string) =>
    new AnthropicModelClient(
      { ...models.roles, extractor: { ...models.roles.extractor, model } } as never,
      {
        ...(keys.anthropic ? { apiKey: keys.anthropic } : {}),
        ...(o.fetch ? { fetch: o.fetch } : {}),
      },
    );
  if (w.model !== "gemini-4-hydrogen") return { model: claude(w.model) };
  if (!keys.gemini)
    throw new Error(
      'website_extractor.model is "gemini-4-hydrogen" but GEMINI_API_KEY is not set (Keys page, or .dev.vars locally)',
    );
  return {
    model: new GeminiModelClient({
      apiKey: keys.gemini,
      model: w.model,
      thinkingLevel: w.gemini_thinking_level,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    }),
    fallbackModel: claude(w.fallback_model),
  };
}
