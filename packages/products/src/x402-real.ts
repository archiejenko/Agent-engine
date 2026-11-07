import { HTTPFacilitatorClient } from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
  X402Facilitator,
} from "./x402.ts";

/**
 * REAL facilitator (cutover): the official @x402/core HTTPFacilitatorClient (2.30.0). Typechecked
 * against its definitions; not yet run against a live facilitator. Testnet first (eip155:84532).
 * A settle() timeout is an indeterminate outcome per the library docs: we treat it as NOT settled and
 * don't serve, and the ledger's unique reference prevents double-recording if it did go through.
 */
export class HttpX402Facilitator implements X402Facilitator {
  readonly dryRun = false;
  private readonly client: HTTPFacilitatorClient;
  constructor(url: string, timeoutMs = 30_000) {
    this.client = new HTTPFacilitatorClient({ url, timeoutMs });
  }
  async verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    const res = await this.client.verify(p as never, r as never);
    return {
      isValid: res.isValid,
      ...(res.invalidReason ? { invalidReason: res.invalidReason } : {}),
      ...(res.payer ? { payer: res.payer } : {}),
    };
  }
  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    try {
      const res = await this.client.settle(p as never, r as never);
      return {
        success: res.success,
        transaction: res.transaction,
        network: res.network,
        ...(res.payer ? { payer: res.payer } : {}),
        ...(res.errorReason ? { errorReason: res.errorReason } : {}),
      };
    } catch (e) {
      return {
        success: false,
        errorReason: `settle error: ${(e as Error).message}`,
        transaction: "",
        network: r.network,
      };
    }
  }
}
