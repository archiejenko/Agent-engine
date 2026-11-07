import { ModuleConfig } from "@ae/contracts";
import { parse as parseYaml, stringify } from "yaml";
import { SIGNALS } from "./signals.ts";

/**
 * Framework notes (brain/frameworks/*.md): YAML front matter = module config. Invalid notes are
 * refused. The note's content hash is recorded on every run (reproducibility).
 */
export interface Framework {
  config: ModuleConfig;
  note_hash: string;
  body: string;
}

export class InvalidFrameworkError extends Error {}

export async function sha256(text: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function splitFrontMatter(note: string): { yaml: string; body: string } {
  const m = note.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new InvalidFrameworkError("note has no YAML front matter (--- ... ---)");
  return { yaml: m[1] as string, body: m[2] as string };
}

export async function parseFramework(note: string): Promise<Framework> {
  const { yaml, body } = splitFrontMatter(note);
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (e) {
    throw new InvalidFrameworkError(`front matter isn't valid YAML: ${(e as Error).message}`);
  }
  const parsed = ModuleConfig.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidFrameworkError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const unknown = Object.keys(parsed.data.signals).filter((s) => !SIGNALS[s]);
  if (unknown.length) throw new InvalidFrameworkError(`unknown signals: ${unknown.join(", ")}`);
  if (typeof (parsed.data.universe as Record<string, unknown>).members_of !== "string") {
    throw new InvalidFrameworkError(
      "universe.members_of must name a universe (e.g. lead_gen_sme_web_v1)",
    );
  }
  return { config: parsed.data, note_hash: await sha256(note), body };
}

export function renderFrontMatter(config: unknown): string {
  return `---\n${stringify(config).trimEnd()}\n---\n`;
}
