import { type PlaybookSpec, PlaybookSpec as PlaybookSpecSchema } from "@ae/contracts";
import { parse as parseYaml } from "yaml";

/** Playbooks live in playbooks/<name>/SKILL.md (front matter = spec) with role prompts alongside. */
export interface LoadedPlaybook {
  spec: PlaybookSpec;
  body: string;
  hash: string;
}

export async function parsePlaybook(skillMd: string): Promise<LoadedPlaybook> {
  const m = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("SKILL.md has no front matter");
  const spec = PlaybookSpecSchema.parse(parseYaml(m[1] as string));
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(skillMd));
  return {
    spec,
    body: m[2] as string,
    hash: [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
