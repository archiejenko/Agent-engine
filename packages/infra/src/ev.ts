import type { InfraConfig } from "@ae/config";
import type { Storage } from "@ae/storage";

/**
 * P(paid) and the expected-value send gate (v2 Phase 1).
 *
 * LEARNING RULES (CLAUDE.md v2 rules 10–12): this module reads the outcome ledger ONLY, through
 * `outcomeLedger.learningCounts`, which excludes synthetic and dry-run rows and anything recorded after
 * `asOf`. It never reads Archie's review decisions (approvals, examples, review sessions): a test
 * checks this file's source for that.
 *
 * Cold start: P(reply) and P(paid | reply) start from priors in config (labelled assumptions) and move
 * towards real rates as sends accumulate (Beta-binomial: the prior counts as `strength` sends).
 */
export interface PaidEstimate {
  playbook: string;
  as_of: string;
  p_reply: number;
  p_close: number;
  p_paid: number;
  /** Real (non-synthetic, non-dry-run) evidence behind the estimate. */
  evidence: { sent: number; reply: number; paid: number };
  /** "prior" until there are real sends; then "prior + ledger". */
  basis: "prior" | "prior + ledger";
  assumptions: string[];
}

const posterior = (prior: number, strength: number, successes: number, trials: number) =>
  (prior * strength + successes) / (strength + trials);

export async function estimatePaid(
  storage: Storage,
  cfg: InfraConfig,
  playbook: string,
  asOf: string = new Date().toISOString(),
): Promise<PaidEstimate> {
  const pr = cfg.measurement.priors;
  const ev = await storage.outcomeLedger.learningCounts(playbook, asOf);
  const p_reply = posterior(pr.reply_rate, pr.strength, Math.min(ev.reply, ev.sent), ev.sent);
  // P(paid | reply): the prior counts as `strength × reply_rate` replies, so it moves at the pace replies arrive.
  const replyStrength = Math.max(1, pr.strength * pr.reply_rate);
  const p_close = posterior(pr.close_rate, replyStrength, Math.min(ev.paid, ev.reply), ev.reply);
  const real = ev.sent > 0;
  return {
    playbook,
    as_of: asOf,
    p_reply,
    p_close,
    p_paid: p_reply * p_close,
    evidence: ev,
    basis: real ? "prior + ledger" : "prior",
    assumptions: [
      `PRIOR_REPLY_RATE = ${pr.reply_rate} (assumption; worth ${pr.strength} sends)`,
      `PRIOR_CLOSE_RATE = ${pr.close_rate} (assumption)`,
      `first-year value £${pr.first_year_value_gbp} (assumption)`,
    ],
  };
}

export type Channel = "email" | "letter";

export function sendCostGbp(cfg: InfraConfig, channel: Channel): number {
  return channel === "email"
    ? cfg.measurement.email_send_cost_gbp
    : cfg.letters.print_cost_gbp + cfg.letters.postage_gbp;
}

export interface EvDecision {
  channel: Channel;
  p_paid: number;
  ev_gbp: number;
  send: boolean;
  reason: string | null;
}

/**
 * EV = P(paid) × first-year value − send cost. Email is only ever the channel when PECR allows it
 * (routing decides that); a letter goes only when EV ≥ k × letter cost.
 */
export function evGate(cfg: InfraConfig, channel: Channel, est: PaidEstimate): EvDecision {
  const cost = sendCostGbp(cfg, channel);
  const ev_gbp = est.p_paid * cfg.measurement.priors.first_year_value_gbp - cost;
  if (channel === "letter") {
    const need = cfg.measurement.letter_ev_k * cost;
    if (ev_gbp < need)
      return {
        channel,
        p_paid: est.p_paid,
        ev_gbp,
        send: false,
        reason: `EV £${ev_gbp.toFixed(2)} is below ${cfg.measurement.letter_ev_k} × letter cost (£${need.toFixed(2)})`,
      };
  } else if (ev_gbp <= 0) {
    return {
      channel,
      p_paid: est.p_paid,
      ev_gbp,
      send: false,
      reason: `EV £${ev_gbp.toFixed(2)} is not positive`,
    };
  }
  return { channel, p_paid: est.p_paid, ev_gbp, send: true, reason: null };
}
