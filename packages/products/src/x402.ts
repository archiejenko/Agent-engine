import type { ProductsConfig } from "@ae/config";

/**
 * x402 v2 payment gate (shapes match @x402/core 2.30 types):
 * - no PAYMENT-SIGNATURE header → 402 with PAYMENT-REQUIRED (base64 JSON PaymentRequired);
 * - with it → facilitator.verify → do the work → facilitator.settle → PAYMENT-RESPONSE header.
 * Money is settled only after the work succeeded, so a failed check is never charged.
 * The facilitator is a port: FakeFacilitator now (fake ledger), HTTPFacilitatorClient at cutover.
 */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
}

export interface X402Facilitator {
  readonly dryRun: boolean;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export const HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

export const b64 = (v: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(v))));
export const unb64 = <T>(s: string): T => JSON.parse(decodeURIComponent(escape(atob(s)))) as T;

export function atomic(usd: number, decimals: number): string {
  return String(Math.round(usd * 10 ** decimals));
}

export function requirementsFor(
  cfg: ProductsConfig["x402"],
  tier: "cached" | "premium",
  payTo: string,
  resource: string,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: cfg.network,
    asset: cfg.asset,
    amount: atomic(cfg.prices_usd[tier], cfg.asset_decimals),
    payTo,
    maxTimeoutSeconds: cfg.max_timeout_seconds,
    extra: { name: "USDC", version: "2", resource, tier },
  };
}

/** Our own checks before trusting a facilitator: the payment must be for exactly what we asked. */
export function matchesRequirements(p: PaymentPayload, r: PaymentRequirements): string | null {
  const a = p.accepted;
  if (p.x402Version !== 2) return "unsupported x402 version";
  if (
    a.scheme !== r.scheme ||
    a.network !== r.network ||
    a.asset.toLowerCase() !== r.asset.toLowerCase()
  )
    return "wrong scheme, network or asset";
  if (a.payTo.toLowerCase() !== r.payTo.toLowerCase()) return "wrong recipient";
  if (BigInt(a.amount) < BigInt(r.amount)) return "amount too low";
  return null;
}

/**
 * Fake facilitator (dry run). A "signed" payload is { authorization: { from, nonce, value }, signature:
 * "fake-valid" }. Rejects bad signatures, low amounts and replays (nonce reuse). Settlement goes to the
 * fake ledger via the callback; no money moves.
 */
export class FakeFacilitator implements X402Facilitator {
  readonly dryRun = true;
  private readonly used = new Set<string>();
  settled: SettleResponse[] = [];

  async verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    const auth = p.payload.authorization as
      | { from?: string; nonce?: string; value?: string }
      | undefined;
    if (p.payload.signature !== "fake-valid" || !auth?.from || !auth.nonce)
      return { isValid: false, invalidReason: "invalid_signature" };
    if (this.used.has(auth.nonce)) return { isValid: false, invalidReason: "nonce_already_used" };
    if (BigInt(auth.value ?? "0") < BigInt(r.amount))
      return { isValid: false, invalidReason: "insufficient_amount" };
    return { isValid: true, payer: auth.from };
  }

  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    const auth = p.payload.authorization as { from: string; nonce: string };
    if (this.used.has(auth.nonce))
      return {
        success: false,
        errorReason: "nonce_already_used",
        transaction: "",
        network: r.network,
      };
    this.used.add(auth.nonce);
    const res = {
      success: true,
      payer: auth.from,
      transaction: `0xfake${auth.nonce.replace(/[^0-9a-f]/gi, "").slice(0, 60)}`,
      network: r.network,
    };
    this.settled.push(res);
    return res;
  }
}

/** Test/demo helper: what a paying agent would send for given requirements. */
export function fakeAgentPayment(
  r: PaymentRequirements,
  from = "0x1111111111111111111111111111111111111111",
  nonce: string = crypto.randomUUID(),
): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: r,
    payload: {
      signature: "fake-valid",
      authorization: { from, to: r.payTo, value: r.amount, nonce },
    },
  };
  return b64(payload);
}
