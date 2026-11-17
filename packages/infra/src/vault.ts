import type { NoteVersionRow, Storage } from "@ae/storage";
import { parse as parseYaml } from "yaml";

/**
 * The Vault (v3 Phase 4): a browser over brain/. Git holds the base notes; every edit is a new version
 * in `note_versions` (rule 21), so neither Archie's text nor anything else is silently overwritten. Agent
 * writes must say who wrote them, when, and what they rest on (sources, ledger rows), and carry the
 * `licensed` / `untrusted` labels of anything they used.
 */
export interface GitNote {
  path: string;
  body: string;
}

export interface Provenance {
  author: string;
  at: string | null;
  sources: string[];
  ledger_rows: number[];
  labels: ("licensed" | "untrusted" | "assumed")[];
}

export interface VaultNote {
  path: string;
  title: string;
  tags: string[];
  body: string;
  version: number;
  author: string;
  updated_at: string | null;
  provenance: Provenance;
  links: string[];
  edited_here: boolean;
}

export function splitFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  try {
    const data = parseYaml(m[1] as string);
    return {
      data: data && typeof data === "object" ? (data as Record<string, unknown>) : {},
      body: text.slice(m[0].length),
    };
  } catch {
    return { data: {}, body: text };
  }
}

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];

/** [[wikilinks]] and relative markdown links to other notes → note paths. */
export function linksOf(path: string, body: string, known: Set<string>): string[] {
  const out = new Set<string>();
  const dir = path.split("/").slice(0, -1).join("/");
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const name = (m[1] as string).trim();
    const hit = [...known].find(
      (p) =>
        p === name || p === `${name}.md` || p.endsWith(`/${name}.md`) || p.endsWith(`/${name}`),
    );
    if (hit) out.add(hit);
  }
  for (const m of body.matchAll(/\]\(([^)\s#]+\.(?:md|csv))(?:#[^)]*)?\)/g)) {
    const target = m[1] as string;
    const parts: string[] = [];
    for (const part of (target.startsWith("brain/") ? target : `${dir}/${target}`).split("/")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    const norm = parts.join("/");
    if (known.has(norm)) out.add(norm);
    else {
      const hit = [...known].find((p) => p.endsWith(`/${target.split("/").pop()}`));
      if (hit) out.add(hit);
    }
  }
  out.delete(path);
  return [...out];
}

function provenanceOf(
  data: Record<string, unknown>,
  author: string,
  at: string | null,
  stored?: unknown,
): Provenance {
  const s = (stored ?? {}) as Partial<Provenance>;
  return {
    author: s.author ?? (typeof data.author === "string" ? data.author : author),
    at: s.at ?? (typeof data.date === "string" ? data.date : at),
    sources: s.sources ?? arr(data.sources),
    ledger_rows: s.ledger_rows ?? [],
    labels: (s.labels ?? arr(data.labels)) as Provenance["labels"],
  };
}

/** Current state of every note: git base overlaid by the newest stored version. */
export async function vaultNotes(storage: Storage, git: GitNote[]): Promise<VaultNote[]> {
  const latest = new Map<string, NoteVersionRow>(
    (await storage.noteVersions.latestAll()).map((v) => [v.path, v]),
  );
  const paths = new Set([...git.map((g) => g.path), ...latest.keys()]);
  const known = new Set(paths);
  const out: VaultNote[] = [];
  for (const path of [...paths].sort()) {
    const base = git.find((g) => g.path === path);
    const v = latest.get(path);
    const text = v?.body ?? base?.body ?? "";
    if (path.endsWith(".csv")) {
      out.push({
        path,
        title: path.split("/").pop() as string,
        tags: ["sheet"],
        body: text,
        version: v?.version ?? 0,
        author: v?.author ?? "git",
        updated_at: v?.created_at ?? null,
        provenance: provenanceOf({}, v?.author ?? "git", null, v?.provenance),
        links: [],
        edited_here: Boolean(v),
      });
      continue;
    }
    const { data, body } = splitFrontMatter(text);
    const title =
      (typeof data.title === "string" && data.title) ||
      body.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
      (path.split("/").pop() as string);
    const tags = [
      ...new Set(
        [
          ...arr(data.tags),
          ...(typeof data.type === "string" ? [data.type] : []),
          path.split("/")[1] ?? "",
        ].filter(Boolean),
      ),
    ];
    out.push({
      path,
      title,
      tags,
      body: text,
      version: v?.version ?? 0,
      author: v?.author ?? "git",
      updated_at: v?.created_at ?? (typeof data.date === "string" ? data.date : null),
      provenance: provenanceOf(data, v?.author ?? "git", v?.created_at ?? null, v?.provenance),
      links: linksOf(path, body, known),
      edited_here: Boolean(v),
    });
  }
  return out;
}

export function backlinksOf(notes: VaultNote[], path: string): string[] {
  return notes.filter((n) => n.links.includes(path)).map((n) => n.path);
}

export function searchVault(notes: VaultNote[], q: { text?: string; tag?: string }): VaultNote[] {
  const t = q.text?.trim().toLowerCase();
  return notes
    .filter((n) => !q.tag || n.tags.includes(q.tag))
    .filter(
      (n) =>
        !t ||
        n.title.toLowerCase().includes(t) ||
        n.body.toLowerCase().includes(t) ||
        n.path.toLowerCase().includes(t),
    )
    .sort(
      (a, b) =>
        (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.path.localeCompare(b.path),
    );
}

const validPath = (p: string) =>
  /^brain\/[a-z0-9][a-z0-9_\-/.]*\.(md|csv)$/i.test(p) && !p.includes("..");

/** Archie edits a note: a new version (the previous text stays in the history). */
export async function writeArchieNote(storage: Storage, path: string, body: string) {
  if (!validPath(path)) throw new Error("notes live under brain/ and end in .md or .csv");
  return storage.noteVersions.add({
    path,
    body,
    author: "archie",
    provenance: {
      author: "archie",
      at: new Date().toISOString(),
      sources: [],
      ledger_rows: [],
      labels: [],
    },
  });
}

/**
 * An agent writes a note. Always a new version, never a replacement (rule 21), and it must say what it
 * rests on: at least one source or ledger row. Labels carry forward (licensed, untrusted, assumed).
 */
export async function writeAgentNote(
  storage: Storage,
  n: {
    path: string;
    body: string;
    agent: string;
    sources: string[];
    ledger_rows?: number[];
    labels?: Provenance["labels"];
  },
) {
  if (!validPath(n.path)) throw new Error("notes live under brain/ and end in .md or .csv");
  if (!n.agent.trim()) throw new Error("an agent note needs its author");
  if (n.sources.length === 0 && (n.ledger_rows ?? []).length === 0)
    throw new Error("an agent note needs its provenance: at least one source or ledger row");
  return storage.noteVersions.add({
    path: n.path,
    body: n.body,
    author: `agent:${n.agent}`,
    provenance: {
      author: `agent:${n.agent}`,
      at: new Date().toISOString(),
      sources: n.sources,
      ledger_rows: n.ledger_rows ?? [],
      labels: n.labels ?? [],
    } satisfies Provenance,
  });
}

// ---- CSV (the ideas sheet itself is handled in ideas.ts).

/** RFC 4180 CSV (quotes, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}
