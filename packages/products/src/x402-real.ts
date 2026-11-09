import { HTTPFacilitatorClient } from "@x402/core/server";
import type { X402Facilitator } from "./x402.ts";

/**
 * REAL facilitator (cutover): the official @x402/core HTTPFacilitatorClient (2.30.0), used as-is by
 * the official middleware. Not yet run against a live facilitator. Testnet first (eip155:84532).
 * If your facilitator needs auth headers, pass `createAuthHeaders` (see docs/live-cutover.md).
 */
export class HttpX402Facilitator extends HTTPFacilitatorClient implements X402Facilitator {
  readonly dryRun = false;
  constructor(url: string) {
    super({ url });
  }
}
