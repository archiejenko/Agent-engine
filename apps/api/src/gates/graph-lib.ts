import type { AgentService } from "@ae/agent-runner";
import { loadGraphPolicy, loadModelsConfig } from "@ae/config";
import { exportNodeLibrary, type NodeLibrary, type PlaybookShape } from "@ae/graph";

/** The node library from a live agent service: its registered tools and its playbooks with their steps. */
export async function libraryFor(service: AgentService): Promise<NodeLibrary> {
  return exportNodeLibrary({
    tools: service.tools.list(),
    models: loadModelsConfig(),
    policy: loadGraphPolicy(),
    playbooks: [...service.playbooks.values()].map((p) => ({
      name: p.spec.playbook,
      version: p.spec.version,
      autonomy: p.spec.autonomy,
      revenue_path: p.spec.revenue_path,
      steps: p.spec.steps as NonNullable<PlaybookShape["steps"]>,
      stats: { runs: 0, success_rate: null, avg_cost_gbp: null },
    })),
  });
}

/** A loaded playbook as the converter's input. */
export const shapeOf = (
  p: AgentService["playbooks"] extends Map<string, infer V> ? V : never,
): PlaybookShape => ({
  playbook: p.spec.playbook,
  version: p.spec.version,
  autonomy: p.spec.autonomy,
  revenue_path: p.spec.revenue_path,
  budget_gbp: p.spec.budget_gbp,
  steps: p.spec.steps as PlaybookShape["steps"],
});
