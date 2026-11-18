import type {
  Autonomy,
  GraphEdge,
  GraphNode,
  GraphSpec,
  Role,
  SpecStateField,
} from "@ae/contracts";

/**
 * Playbook → GraphSpec (graph plan, G1). Deterministic and mechanical, so a converted playbook does
 * exactly what the old runner (packages/infra/src/runner.ts) does with it:
 * - each role step is a role node bound to the SAME step code (`config: {playbook, step}`), reading
 *   every earlier output, as the old runner passed them all;
 * - a checker right after a producer gets the old "retry once with the reasons" as a loop edge
 *   (maxIterations 1), then a review approval when it fails twice. Approving that review resumes after
 *   the playbook's first gate, as the old runner does;
 * - a gate is an approval node. At L3 gates are left out and at L0 operator steps are left out
 *   (the old runner skips both);
 * - an outreach send (policy `outreach_send_tools`) gets explicit suppression and 90-day cooldown
 *   function nodes immediately before it (compiler rule 12). The send tools still check too.
 */
export type PlaybookStep =
  | { id: string; role: Role; tools: string[]; output: string }
  | { id: string; gate: string };

export interface PlaybookShape {
  playbook: string;
  version: number;
  autonomy: Autonomy;
  revenue_path: string;
  budget_gbp: number;
  steps: PlaybookStep[];
}

const isRole = (s: PlaybookStep): s is Extract<PlaybookStep, { role: Role }> => "role" in s;

export const verdictKey = (checkId: string) => `${checkId}_verdict`;
export const feedbackKey = (checkId: string) => `${checkId}_feedback`;
export const reviewNodeId = (checkId: string) => `${checkId}_review`;
export const ENTITY_KEY = "entity_ref";
export const ALLOWED_KEY = "outreach_allowed";
export const OUTREACH_CHECKS = [
  ["suppression", "suppression_check"],
  ["cooldown", "contact_cooldown"],
] as const;

const round6 = (x: number) => Math.floor(x * 1e6) / 1e6;

/**
 * Tool narrowing applied when converting (a graph may narrow a step's tools, never widen them). Each entry
 * is a tool a step lists but whose code never calls it; the equivalence test proves behaviour is unchanged.
 * - sme_outreach research lists web_fetch, but builds the brief only from verified facts
 *   (packages/infra/src/playbooks/sme_outreach.ts). Narrowing lets the compiler prove that no fetched
 *   text can reach the send (rule 9).
 */
export const CONVERSION_NARROWING: Record<string, Record<string, string[]>> = {
  sme_outreach: { research: ["verified_facts"] },
};

export function playbookToGraph(
  pb: PlaybookShape,
  o: { outreachSendTools: string[]; taskId?: string },
): GraphSpec {
  const narrow = CONVERSION_NARROWING[pb.playbook] ?? {};
  const steps = pb.steps.filter((s) => {
    if (pb.autonomy === "L0" && isRole(s) && s.role === "operator") return false;
    if (pb.autonomy === "L3" && !isRole(s)) return false;
    return true;
  });
  const isSend = (s: PlaybookStep) =>
    isRole(s) && s.tools.some((t) => o.outreachSendTools.includes(t));
  const isCheckAt = (i: number) => {
    const s = steps[i];
    const prev = steps[i - 1];
    return (
      !!s && isRole(s) && s.role === "checker" && !!prev && isRole(prev) && prev.role !== "operator"
    );
  };

  const state: Record<string, SpecStateField> = {};
  const inputs: string[] = [];
  const nodes: GraphNode[] = [];
  /** The main chain, in order; a check also carries its producer and review node. */
  const chain: { id: string; kind: "node" | "check" | "fn"; producer?: string; review?: string }[] =
    [];
  const written: string[] = [];
  const addWritten = (k: string) => {
    if (!written.includes(k)) written.push(k);
  };
  /** Outputs written by writer steps so far: what an edit at an approval can change. */
  const writerOutputs: string[] = [];
  const outputsSoFar = () =>
    written.filter((k) => k !== ALLOWED_KEY && !k.endsWith("_feedback") && !k.endsWith("_verdict"));

  // Even, deterministic split of the budget across model-calling nodes (a node in a check loop counts twice).
  let units = 0;
  steps.forEach((s, i) => {
    if (isRole(s)) units += isCheckAt(i) || isCheckAt(i + 1) ? 2 : 1;
  });
  const perUnit = units ? round6(pb.budget_gbp / units) : 0;

  if (steps.some(isSend)) {
    state[ENTITY_KEY] = { type: "string", untrusted: false };
    state[ALLOWED_KEY] = { type: "boolean", untrusted: false };
    inputs.push(ENTITY_KEY);
  }

  steps.forEach((s, i) => {
    if (isSend(s))
      for (const [id, fn] of OUTREACH_CHECKS) {
        nodes.push({
          id,
          kind: "function",
          ref: fn,
          reads: [ENTITY_KEY],
          writes: [ALLOWED_KEY],
          budget: { maxCostGbp: 0, maxDurationS: 60 },
        });
        chain.push({ id, kind: "fn" });
        addWritten(ALLOWED_KEY);
      }
    if (isRole(s)) {
      state[s.output] ??= { type: "json", untrusted: false };
      const reads = [...outputsSoFar()];
      const writes = [s.output];
      if (isCheckAt(i + 1)) {
        const fk = feedbackKey((steps[i + 1] as PlaybookStep).id);
        state[fk] = { type: "string", untrusted: false };
        if (!inputs.includes(fk)) inputs.push(fk);
        reads.push(fk);
      }
      const check = isCheckAt(i);
      if (check) {
        state[verdictKey(s.id)] = { type: "enum", enumValues: ["pass", "fail"], untrusted: false };
        writes.push(verdictKey(s.id), feedbackKey(s.id));
      }
      nodes.push({
        id: s.id,
        kind: "role",
        ref: s.role,
        reads,
        writes,
        config: {
          playbook: pb.playbook,
          step: s.id,
          ...(narrow[s.id] ? { tools: narrow[s.id] } : {}),
        },
        budget: { maxCostGbp: perUnit, maxDurationS: 600 },
      });
      for (const w of writes) addWritten(w);
      if (s.role === "writer" && !writerOutputs.includes(s.output)) writerOutputs.push(s.output);
      if (check) {
        const review = reviewNodeId(s.id);
        state.approved = { type: "boolean", untrusted: false };
        nodes.push({
          id: review,
          kind: "approval",
          ref: "archie",
          reads: outputsSoFar(),
          writes: ["approved", ...writerOutputs],
          config: { kind: "check_failed", playbook: pb.playbook },
          budget: { maxCostGbp: 0, maxDurationS: 7 * 86_400 },
        });
        chain.push({
          id: s.id,
          kind: "check",
          producer: (steps[i - 1] as PlaybookStep).id,
          review,
        });
      } else chain.push({ id: s.id, kind: "node" });
    } else {
      state.approved = { type: "boolean", untrusted: false };
      nodes.push({
        id: s.id,
        kind: "approval",
        ref: "archie",
        reads: outputsSoFar(),
        writes: ["approved", ...writerOutputs],
        config: { kind: "gate", playbook: pb.playbook },
        budget: { maxCostGbp: 0, maxDurationS: 7 * 86_400 },
      });
      chain.push({ id: s.id, kind: "node" });
      addWritten("approved");
    }
  });

  // Wiring: consecutive chain entries, then each check's loop and review.
  const edges: GraphEdge[] = [];
  const exits: string[] = [];
  const firstGateIdx = chain.findIndex(
    (c) => nodes.find((n) => n.id === c.id)?.kind === "approval",
  );
  const afterFirstGate = firstGateIdx >= 0 ? chain[firstGateIdx + 1]?.id : undefined;
  chain.forEach((c, k) => {
    const next = chain[k + 1]?.id;
    if (c.kind === "fn") {
      if (next)
        edges.push({ from: c.id, to: next, when: { key: ALLOWED_KEY, op: "eq", value: true } });
      else exits.push(c.id);
    } else if (c.kind === "check") {
      edges.push({
        from: c.id,
        to: c.producer as string,
        when: { key: verdictKey(c.id), op: "eq", value: "fail" },
        loop: { maxIterations: 1 },
      });
      edges.push({
        from: c.id,
        to: c.review as string,
        when: { key: verdictKey(c.id), op: "eq", value: "fail" },
      });
      if (next)
        edges.push({
          from: c.id,
          to: next,
          when: { key: verdictKey(c.id), op: "eq", value: "pass" },
        });
      else exits.push(c.id);
      // Approving a twice-failed check resumes after the playbook's first gate (old runner behaviour);
      // with no gate, it continues with the next step.
      const resume = firstGateIdx >= 0 ? afterFirstGate : next;
      if (resume) edges.push({ from: c.review as string, to: resume });
      else exits.push(c.review as string);
    } else if (next) edges.push({ from: c.id, to: next });
    else exits.push(c.id);
  });

  return {
    graphId: `pb-${pb.playbook.replace(/_/g, "-")}`,
    version: pb.version,
    taskId: o.taskId ?? `playbook:${pb.playbook}`,
    goal: `Run the ${pb.playbook} playbook (v${pb.version}) as a graph, doing exactly what the old runner does.`,
    successMetric: { name: "run finished", target: 1, unit: "runs", measuredBy: "draft_approved" },
    stopConditions: ["budget reached", "rejected by Archie", "outreach not allowed"],
    budgetGbp: pb.budget_gbp,
    state,
    inputs,
    nodes,
    edges,
    entry: (chain[0] as { id: string }).id,
    exits: [...new Set(exits)],
    planner: {
      model: "none",
      promptVersion: "converted",
      rationale: `Converted mechanically from playbooks/${pb.playbook}/SKILL.md v${pb.version} at ${pb.autonomy}.`,
      assumptions: [],
    },
  };
}
