import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";

export const ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_DB = resolve(ROOT, "data/dev.sqlite");

/** Read KEY=VALUE lines from .dev.vars (git-ignored). Values are never printed. */
export function loadDevVars(): Record<string, string> {
  const path = resolve(ROOT, ".dev.vars");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export async function openDb(path = process.env.AE_DB ?? DEFAULT_DB) {
  return openSqliteStorage(path);
}

export function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

/** Pull a YYYY-MM-DD date out of a file name, if there is one. */
export function dateFromName(name: string): string | null {
  return name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}
