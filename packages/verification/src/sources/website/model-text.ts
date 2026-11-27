import { usefulText } from "@ae/ports";

/**
 * What the extractor model sees of a site (2026-11-27): each page's useful text (no scripts, styles,
 * menus, forms or cookie banners), lines already seen on an earlier page dropped (the same footer on
 * every page goes once), then cut to a per-page token budget from config. Tokens are estimated as
 * characters / chars_per_token. Only the MODEL's input is cut: the full page text still feeds the
 * deterministic checks and the evidence check.
 */
export interface ModelTextConfig {
  page_token_budget: number;
  chars_per_token: number;
}
export interface PageCutInfo {
  url: string;
  /** The page's useful text before the cut. */
  original_tokens: number;
  kept_tokens: number;
}

export const estimateTokens = (text: string, cpt: number) => Math.ceil(text.length / cpt);

export function pagesForModel(
  pages: { url: string; html: string }[],
  cfg: ModelTextConfig,
): { pages: { url: string; text: string }[]; cuts: PageCutInfo[] } {
  const seen = new Set<string>();
  const cuts: PageCutInfo[] = [];
  const maxChars = cfg.page_token_budget * cfg.chars_per_token;
  const out = pages.map((p) => {
    const full = usefulText(p.html);
    const lines = full.split("\n").filter((l) => {
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    });
    let text = lines.join("\n");
    if (text.length > maxChars) {
      // Cut at the last line break inside the budget (or hard at the budget if there isn't one).
      const nl = text.lastIndexOf("\n", maxChars);
      text = text.slice(0, nl > maxChars * 0.8 ? nl : maxChars);
      cuts.push({
        url: p.url,
        original_tokens: estimateTokens(full, cfg.chars_per_token),
        kept_tokens: estimateTokens(text, cfg.chars_per_token),
      });
    }
    return { url: p.url, text };
  });
  return { pages: out, cuts };
}
