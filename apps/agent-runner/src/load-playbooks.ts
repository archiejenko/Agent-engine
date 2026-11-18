import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LoadedPlaybook, parsePlaybook } from "@ae/infra";

// Node only (reads the playbooks/ folder). On Workers, playbooks come from loadBundledPlaybooks().
/** Load every playbooks/<name>/SKILL.md. */
export async function loadPlaybooks(dir: string): Promise<Map<string, LoadedPlaybook>> {
  const out = new Map<string, LoadedPlaybook>();
  for (const name of readdirSync(dir)) {
    // Folders starting with "_" hold prompts that aren't playbooks (e.g. _planner, graph plan G4).
    if (name.startsWith("_")) continue;
    try {
      const pb = await parsePlaybook(readFileSync(join(dir, name, "SKILL.md"), "utf8"));
      out.set(pb.spec.playbook, pb);
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "ENOTDIR" &&
        (e as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw e;
    }
  }
  return out;
}
