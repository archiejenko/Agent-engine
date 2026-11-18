import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlaybooks } from "@ae/agent-runner";
import { loadGraphPolicy } from "@ae/config";
import { playbookToGraph } from "@ae/graph";
import { bundle } from "./gen-playbooks.ts";
import { ROOT } from "./lib.ts";

/**
 * Writes playbooks/<name>/graph.json for every playbook the old runner runs, converted mechanically
 * (graph plan, G1). claim_site runs only as a workflow, so its graph.json is written by hand.
 * The G1 gate fails if a committed graph.json differs from a fresh conversion.
 */
export const HAND_CONVERTED = ["claim_site"];

export async function convertedGraphs() {
  const policy = loadGraphPolicy();
  const out = new Map<string, unknown>();
  for (const p of (await loadPlaybooks(join(ROOT, "playbooks"))).values()) {
    if (HAND_CONVERTED.includes(p.spec.playbook)) continue;
    out.set(
      p.spec.playbook,
      playbookToGraph(
        {
          playbook: p.spec.playbook,
          version: p.spec.version,
          autonomy: p.spec.autonomy,
          revenue_path: p.spec.revenue_path,
          budget_gbp: p.spec.budget_gbp,
          steps: p.spec.steps as never,
        },
        { outreachSendTools: policy.guardrails.outreach_send_tools },
      ),
    );
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const written: string[] = [];
  for (const [name, spec] of await convertedGraphs()) {
    const f = join(ROOT, "playbooks", name, "graph.json");
    writeFileSync(f, `${JSON.stringify(spec, null, 2)}\n`);
    written.push(f);
    console.log(`playbooks/${name}/graph.json`);
  }
  // Same layout as the rest of the repo (the gate compares parsed JSON, so layout never matters to it).
  execFileSync("pnpm", ["exec", "biome", "format", "--write", ...written], {
    cwd: ROOT,
    stdio: "ignore",
  });
  // The Worker's bundle carries the graphs too.
  writeFileSync(join(ROOT, "packages/infra/src/playbooks.generated.ts"), bundle());
}
