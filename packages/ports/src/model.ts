/**
 * ModelClient port: the only way any code talks to a language model.
 * Fake: deterministic, returns recorded/simulated responses. Real (cutover): Claude API.
 * All maths stays in code; the model only writes text and extracts values (which are then checked).
 */
export interface ModelRequest {
  /** Stable prompt identifier, e.g. "website_extract". Prompts are versioned files. */
  prompt_id: string;
  prompt_version: number;
  /** Which configured model/effort to use (roles map to models in config). */
  role:
    | "extractor"
    | "researcher"
    | "writer"
    | "checker"
    | "explainer"
    | "adjudicator"
    | "verifier";
  system: string;
  /** Untrusted content (web pages, emails) must be passed in `untrusted`, never mixed into `system`. */
  user: string;
  untrusted?: string;
  /** JSON schema the answer must follow (structured output). */
  json_schema?: Record<string, unknown>;
  max_tokens: number;
}

export interface ModelResult {
  text: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: "end_turn" | "max_tokens" | "refusal" | "other";
}

export interface ModelClient {
  readonly name: string;
  complete(req: ModelRequest): Promise<ModelResult>;
}

type Handler = (req: ModelRequest) => string;

/**
 * Deterministic fake model. Each prompt_id has a handler that simulates the model from the input
 * (or a recording keyed by prompt_id + input hash). Token usage is estimated (4 chars ≈ 1 token)
 * so cost reporting works end to end.
 */
export class FakeModel implements ModelClient {
  readonly name = "fake-model";
  calls: ModelRequest[] = [];
  constructor(
    private readonly handlers: Record<string, Handler>,
    private readonly recordings: Record<string, string> = {},
  ) {}

  async complete(req: ModelRequest): Promise<ModelResult> {
    this.calls.push(req);
    const key = `${req.prompt_id}:${await sha1(req.user + (req.untrusted ?? ""))}`;
    const recorded = this.recordings[key];
    const handler = this.handlers[req.prompt_id];
    if (recorded === undefined && !handler)
      throw new Error(`FakeModel has no handler for prompt ${req.prompt_id}`);
    const text = recorded ?? (handler as Handler)(req);
    const tokens = (s: string) => Math.ceil(s.length / 4);
    return {
      text,
      model: "fake-model",
      usage: {
        input_tokens: tokens(req.system + req.user + (req.untrusted ?? "")),
        output_tokens: tokens(text),
      },
      stop_reason: "end_turn",
    };
  }
}

async function sha1(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Price per million tokens in USD, from config; converted to GBP with the configured rate. */
export interface ModelPrice {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

export function costGbp(usage: ModelResult["usage"], price: ModelPrice, usdToGbp: number): number {
  const usd =
    (usage.input_tokens * price.input_usd_per_mtok +
      usage.output_tokens * price.output_usd_per_mtok) /
    1_000_000;
  return usd * usdToGbp;
}
