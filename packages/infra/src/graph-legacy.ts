import type { InfraConfig } from "@ae/config";
import type { CompiledGraph, GraphNode } from "@ae/contracts";
import {
  type Bindings,
  feedbackKey,
  type NodeContext,
  type NodeOutcome,
  newRunState,
  type RunState,
  runGraph,
  verdictKey,
} from "@ae/graph";
import type { Storage, StoredTask } from "@ae/storage";
import { contactBlock } from "./contact.ts";
import { queuePaused } from "./controls.ts";
import { playbooksPausedByKeys } from "./keys.ts";
import { letterSuppressionKey } from "./playbooks/sme_letter.ts";
import type { PlaybookRunner } from "./runner.ts";

/**
 * Runs a task as its converted graph (graph plan, G1). Role nodes call the SAME step code as the old
 * runner (PlaybookRunner.runStepForGraph), approval nodes use the same gate item and edit logic, and the
 * task's status moves exactly as the old runner moves it. Dry-run throughout: the tool registry and the
 * kill switch decide, as before.
 */
export interface LegacyGraphDeps {
  storage: Storage;
  cfg: InfraConfig;
  runner: PlaybookRunner;
  /** The cost mode node spend is labelled with (the graph runtime's: "sandbox" in a sandbox). */
  mode?: "live" | "sandbox" | "probe" | "planner";
}

interface GraphTaskState {
  graph?: RunState;
  awaiting?: { step_id: string; item: unknown; kind: "gate" | "check_failed" };
  [k: string]: unknown;
}

const entityOf = (sourceRef: string) => sourceRef.match(/entity:([^:]+)$/)?.[1] ?? "";

export function legacyBindings(d: LegacyGraphDeps, task: StoredTask): Bindings {
  const tags = (ctx: NodeContext) => ({
    graph_id: ctx.compiled.spec.graphId,
    graph_version: ctx.compiled.spec.version,
    node_id: ctx.node.id,
    run_id: ctx.runId,
    shape: ctx.compiled.shapeFingerprint,
    ...(d.mode ? { mode: d.mode } : {}),
  });
  return {
    async run(ctx): Promise<NodeOutcome> {
      const n = ctx.node;
      const cfg = (n.config ?? {}) as { playbook?: string; step?: string; kind?: string };
      if (n.kind === "role") {
        const feedback = n.reads.filter((k) => k.endsWith("_feedback")).map((k) => ctx.inputs[k]);
        const retry = feedback.find((f) => typeof f === "string" && f.length > 0) as
          | string
          | undefined;
        // The step sees the earlier outputs only (never the loop feedback keys), as in the old runner.
        const inputs = Object.fromEntries(
          Object.entries(ctx.inputs).filter(([k]) => !k.endsWith("_feedback")),
        );
        const res = await d.runner.runStepForGraph(
          task.task_id,
          cfg.step as string,
          inputs,
          retry ?? null,
          tags(ctx),
        );
        const writes: Record<string, unknown> = { [n.writes[0] as string]: res.output };
        const vk = verdictKey(n.id);
        if (n.writes.includes(vk)) {
          writes[vk] = res.check?.passed ? "pass" : "fail";
          writes[feedbackKey(n.id)] = (res.check?.reasons ?? []).join("; ");
        }
        return { status: "done", writes };
      }
      if (n.kind === "function") {
        const entity = String(ctx.inputs.entity_ref ?? "");
        if (n.ref === "suppression_check")
          return {
            status: "done",
            writes: {
              outreach_allowed: !(await d.storage.suppressions.isSuppressed(
                letterSuppressionKey(entity),
              )),
            },
          };
        if (n.ref === "contact_cooldown") {
          const followup = (task.state as { followup?: { thread_id: string } }).followup;
          const block = await contactBlock(d.storage, d.cfg, entity, {
            taskId: task.task_id,
            ...(followup ? { threadId: followup.thread_id } : {}),
          });
          return { status: "done", writes: { outreach_allowed: block === null } };
        }
        throw new Error(`function ${n.ref} has no legacy implementation`);
      }
      if (n.kind === "approval") {
        const outputs = ctx.inputs;
        const gate = d.runner.gateForGraph(cfg.playbook as string, outputs);
        if (cfg.kind === "check_failed") {
          const check = Object.values(outputs).find(
            (v) => !!v && typeof v === "object" && (v as { passed?: unknown }).passed === false,
          ) as { reasons?: string[] } | undefined;
          await d.storage.alerts.raise(
            "check_failed",
            `Task ${task.task_id} failed its check twice; waiting for review`,
            {
              passed: false,
              reasons: check?.reasons ?? [],
            },
          );
          return {
            status: "waiting",
            kind: "check_failed",
            item: { reasons: check?.reasons ?? [], draft: gate.item },
          };
        }
        return { status: "waiting", kind: "gate", item: gate.item };
      }
      throw new Error(`${n.kind} nodes aren't used by converted playbooks`);
    },
  };
}

/** The outcome of Archie's decision on the approval node a task is waiting on (same records as decide()). */
async function decisionOutcome(
  d: LegacyGraphDeps,
  task: StoredTask,
  compiled: CompiledGraph,
  st: GraphTaskState,
  decision: "approve" | "edit" | "reject",
  editedText: string | null,
): Promise<{ nodeId: string; outcome: NodeOutcome }> {
  const rs = st.graph as RunState;
  const nodeId = rs.waitingOn as string;
  const node = compiled.spec.nodes.find((n) => n.id === nodeId) as GraphNode;
  const cfg = node.config as { playbook: string; kind: string };
  if (decision === "edit" && !editedText) throw new Error("an edit needs the edited text");
  const inputs = Object.fromEntries(node.reads.map((k) => [k, rs.values[k]]));
  const stepId = cfg.kind === "check_failed" ? nodeId.replace(/_review$/, "") : nodeId;
  await d.storage.approvals.add({
    task_id: task.task_id,
    step_id: stepId,
    item_shown: rs.waitingItem,
    decision,
    edited_text: decision === "edit" ? editedText : null,
    graph_id: compiled.spec.graphId,
    graph_version: compiled.spec.version,
    node_id: nodeId,
  });
  if (decision === "reject") return { nodeId, outcome: { status: "rejected" } };
  const writes: Record<string, unknown> = { approved: true };
  if (decision === "edit") {
    const before = d.runner.gateForGraph(cfg.playbook, inputs);
    const after = d.runner.gateForGraph(cfg.playbook, inputs, editedText as string);
    for (const k of node.writes)
      if (k !== "approved" && k in after.outputs) writes[k] = after.outputs[k];
    await d.storage.examples.add({
      playbook: task.playbook,
      step_id: "draft",
      task_id: task.task_id,
      original: JSON.stringify(before.item),
      edited: editedText as string,
    });
  }
  return { nodeId, outcome: { status: "done", writes } };
}

/** Runs (or resumes, with a decision) a task through its converted graph. Mirrors PlaybookRunner.run. */
export async function runTaskAsGraph(
  d: LegacyGraphDeps,
  taskId: string,
  compiled: CompiledGraph,
  decision?: { decision: "approve" | "edit" | "reject"; editedText?: string | null },
): Promise<StoredTask> {
  if (await queuePaused(d.storage)) throw new Error("queue is paused (spend cap or manual pause)");
  const task = (await d.storage.tasks.get(taskId)) as StoredTask;
  if (!task) throw new Error(`no task ${taskId}`);
  if (task.playbook_version !== compiled.spec.version)
    throw new Error(`task needs ${task.playbook} v${task.playbook_version}`);
  if ((await playbooksPausedByKeys(d.storage)).get(task.playbook)) return task;
  const st = (task.state ?? {}) as GraphTaskState;
  let resume: { nodeId: string; outcome: NodeOutcome } | undefined;
  if (decision) {
    if (task.status !== "awaiting_approval" || st.graph?.status !== "waiting")
      throw new Error(`task ${taskId} isn't waiting for approval`);
    resume = await decisionOutcome(
      d,
      task,
      compiled,
      st,
      decision.decision,
      decision.editedText ?? null,
    );
    delete st.awaiting;
  } else if (
    task.status === "done" ||
    task.status === "cancelled" ||
    task.status === "awaiting_approval"
  )
    return task;

  const inputs: Record<string, unknown> = { entity_ref: entityOf(task.source_ref) };
  const rs = st.graph ?? newRunState(task.task_id.replace(/-/g, ""), compiled, inputs);
  await d.storage.tasks.update(task.task_id, { status: "running" });
  try {
    const out = await runGraph(compiled, legacyBindings(d, task), rs, resume);
    const nextState: GraphTaskState = { ...st, graph: out };
    if (out.status === "waiting") {
      const node = compiled.spec.nodes.find((n) => n.id === out.waitingOn) as GraphNode;
      const kind =
        (node.config as { kind?: string }).kind === "check_failed" ? "check_failed" : "gate";
      nextState.awaiting = {
        step_id: kind === "check_failed" ? node.id.replace(/_review$/, "") : node.id,
        item: out.waitingItem,
        kind,
      };
      await d.storage.tasks.update(task.task_id, { status: "awaiting_approval", state: nextState });
    } else if (out.status === "rejected") {
      await d.storage.tasks.update(task.task_id, { status: "cancelled", state: nextState });
    } else if (out.status === "stopped") {
      await d.storage.tasks.update(task.task_id, {
        status: "cancelled",
        error: `stopped at ${out.stoppedAt}: outreach not allowed`,
        state: nextState,
      });
    } else await d.storage.tasks.update(task.task_id, { status: "done", state: nextState });
  } catch (e) {
    await d.storage.tasks.update(task.task_id, {
      status: "failed",
      error: (e as Error).message.slice(0, 500),
      state: { ...st, graph: rs },
    });
  }
  return (await d.storage.tasks.get(task.task_id)) as StoredTask;
}
