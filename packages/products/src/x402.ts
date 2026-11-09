import type { ProductsConfig } from "@ae/config";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

/**
 * x402 v2, the standard way: the official `@x402/hono` payment middleware with an
 * `x402ResourceServer` and the `exact` EVM scheme (wired in apps/api). The flow is the library's:
 * no PAYMENT-SIGNATURE → 402 + PAYMENT-REQUIRED; with it → facilitator verify → our handler runs →
 * the facilitator settles ONLY if the handler answered < 400 → PAYMENT-RESPONSE header.
 *
 * What lives here: the facilitator port (the library's `FacilitatorClient` plus a dry-run flag), the
 * fake facilitator used locally and in tests (no money moves), the kill-switch guard, and the price.
 */
export type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse };

export interface X402Facilitator extends FacilitatorClient {
  readonly dryRun: boolean;
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

/** The price for a tier, as an explicit token amount with the token's EIP-712 domain (from config). */
export function priceFor(cfg: ProductsConfig["x402"], tier: "cached" | "premium"): AssetAmount {
  return {
    asset: cfg.asset,
    amount: atomic(cfg.prices_usd[tier], cfg.asset_decimals),
    extra: { name: cfg.eip712.name, version: cfg.eip712.version },
  };
}

interface Authorization {
  from?: string;
  to?: string;
  value?: string;
  validAfter?: string;
  validBefore?: string;
  nonce?: string;
}

/**
 * Fake facilitator (dry run). Mirrors what a real facilitator checks for an EIP-3009 "exact" payment:
 * signature (fake: "fake-valid"), recipient, amount, network/asset, validity window
 * (validAfter ≤ now < validBefore, and no longer than maxTimeoutSeconds), and nonce replay. Settlement
 * records to `settled`; the API writes the fake ledger. No money moves.
 */
export class FakeFacilitator implements X402Facilitator {
  readonly dryRun = true;
  private readonly used = new Set<string>();
  settled: SettleResponse[] = [];
  constructor(
    private readonly networks: Network[] = ["eip155:84532"],
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: this.networks.map((network) => ({ x402Version: 2, scheme: "exact", network })),
      extensions: [],
      signers: {},
    };
  }

  private check(p: PaymentPayload, r: PaymentRequirements): VerifyResponse {
    const auth = (p.payload.authorization ?? {}) as Authorization;
    const payer = auth.from;
    const bad = (invalidReason: string): VerifyResponse => ({
      isValid: false,
      invalidReason,
      ...(payer ? { payer } : {}),
    });
    if (p.x402Version !== 2) return bad("unsupported_version");
    if (p.payload.signature !== "fake-valid" || !auth.from || !auth.nonce)
      return bad("invalid_signature");
    if (
      p.accepted.network !== r.network ||
      p.accepted.asset.toLowerCase() !== r.asset.toLowerCase()
    )
      return bad("network_or_asset_mismatch");
    if (auth.to?.toLowerCase() !== r.payTo.toLowerCase()) return bad("recipient_mismatch");
    if (BigInt(auth.value ?? "0") < BigInt(r.amount)) return bad("insufficient_amount");
    const now = this.nowSec();
    const after = Number(auth.validAfter ?? Number.NaN);
    const before = Number(auth.validBefore ?? Number.NaN);
    if (!Number.isFinite(after) || !Number.isFinite(before)) return bad("missing_validity_window");
    if (now < after) return bad("not_yet_valid");
    if (now >= before) return bad("expired");
    if (before - now > r.maxTimeoutSeconds + 60) return bad("validity_window_too_long");
    if (this.used.has(auth.nonce)) return bad("nonce_already_used");
    return { isValid: true, payer: auth.from };
  }

  async verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    return this.check(p, r);
  }

  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    const v = this.check(p, r);
    if (!v.isValid)
      return {
        success: false,
        errorReason: v.invalidReason ?? "invalid",
        transaction: "",
        network: r.network,
      };
    const auth = p.payload.authorization as Required<Authorization>;
    this.used.add(auth.nonce);
    const res: SettleResponse = {
      success: true,
      payer: auth.from,
      transaction: `0xfake${auth.nonce.replace(/[^0-9a-f]/gi, "").slice(0, 60)}`,
      network: r.network,
    };
    this.settled.push(res);
    return res;
  }
}

/** Refuses payments while the kill switch is on (guardrail 7): nobody pays for what we won't serve. */
export function guardedFacilitator(
  inner: X402Facilitator,
  allowed: () => Promise<boolean>,
): X402Facilitator {
  return {
    dryRun: inner.dryRun,
    getSupported: () => inner.getSupported(),
    async verify(p, r) {
      if (!(await allowed())) return { isValid: false, invalidReason: "service_paused" };
      return inner.verify(p, r);
    },
    async settle(p, r) {
      if (!(await allowed()))
        return {
          success: false,
          errorReason: "service_paused",
          transaction: "",
          network: r.network,
        };
      return inner.settle(p, r);
    },
  };
}

/** Test/demo helper: the PAYMENT-SIGNATURE a paying agent would send (EIP-3009 shape, fake signature). */
export function fakeAgentPayment(
  r: PaymentRequirements,
  o: {
    from?: string;
    nonce?: string;
    validAfter?: number;
    validBefore?: number;
    resource?: string;
  } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: PaymentPayload = {
    x402Version: 2,
    ...(o.resource ? { resource: { url: o.resource } } : {}),
    accepted: r,
    payload: {
      signature: "fake-valid",
      authorization: {
        from: o.from ?? "0x1111111111111111111111111111111111111111",
        to: r.payTo,
        value: r.amount,
        validAfter: String(o.validAfter ?? now - 5),
        validBefore: String(o.validBefore ?? now + r.maxTimeoutSeconds),
        nonce: o.nonce ?? `0x${crypto.randomUUID().replace(/-/g, "")}`,
      },
    },
  };
  return b64(payload);
}
