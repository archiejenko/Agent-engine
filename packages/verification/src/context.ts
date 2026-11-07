import {
  loadConfidenceConfigChecked,
  loadFieldRegistry,
  loadVerificationConfig,
  type VerificationConfig,
} from "@ae/config";
import type { ConfidenceConfig, FieldDefinition } from "@ae/contracts";

/** Everything the verification engine needs besides storage. Built once per run. */
export interface VerificationContext {
  registry: Map<string, FieldDefinition>;
  confidence: ConfidenceConfig;
  verification: VerificationConfig;
  /** "source|field" pairs paused by drift monitoring: they can't make facts verified. */
  paused?: Set<string>;
}

export function defaultContext(): VerificationContext {
  return {
    registry: loadFieldRegistry(),
    confidence: loadConfidenceConfigChecked(),
    verification: loadVerificationConfig(),
  };
}

export function sourceInfo(ctx: VerificationContext, source: string, tier: number) {
  const s = ctx.confidence.sources[source];
  const prior = ctx.confidence.tier_priors[String(tier) as "1" | "2" | "3" | "4" | "5"];
  return {
    /** Reliability r: tier prior until measured reliability replaces it (Phase 3). */
    reliability: prior,
    /** Sources copying the same upstream count once. Unknown sources are their own upstream. */
    upstream: s?.upstream ?? source,
    continuous: s?.continuous ?? false,
  };
}
