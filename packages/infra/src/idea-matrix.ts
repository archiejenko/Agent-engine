import type { IdeaMatrixRow, Storage } from "@ae/storage";
import { parseCsv } from "./vault.ts";

/**
 * Archie's ranked idea matrix (brain/ideas/ranked-ideas.csv, 2026-11-24) → the `idea_matrix` backlog.
 *
 * It keeps Archie's OWN four scores (fit, speed to £, demand, solo-build; 1–5 each) rather than forcing
 * them into the six seeded scores, so nothing is invented (Archie's choice, 2026-11-24). Rule 23: every
 * score is an ESTIMATE, never an outcome, never in the outcome ledger, never read by scoring or learning.
 *
 * - The file is kept exactly as Archie wrote it (a title line, a blank line, then the header).
 * - Score (the sum) and rank (competition ranking: 1, 2, 2, 4) are recomputed in code; the file's own
 *   values are only compared, and any difference is reported.
 * - Ids are stable: `R` + the sheet's "List #", so a re-import updates the same rows. Archie's decision
 *   and comments are never overwritten. A file with any invalid row is rejected whole.
 */
export const IDEA_MATRIX_PATH = "brain/ideas/ranked-ideas.csv";
export const MATRIX_SCORES = ["fit", "speed_to_cash", "demand", "solo_build"] as const;

const HEADER = [
  "Rank",
  "Idea",
  "Score",
  "Your build angle",
  "Fit",
  "Speed to £",
  "Demand",
  "Solo-build",
  "List #",
];

export interface MatrixRow {
  id: string;
  list_no: number;
  rank: number;
  idea: string;
  build_angle: string;
  fit: number;
  speed_to_cash: number;
  demand: number;
  solo_build: number;
  score: number;
}
export interface MatrixReport {
  ok: boolean;
  note: string | null;
  rows: MatrixRow[];
  rejected: { line: number; reason: string }[];
  mismatches: { id: string; field: "score" | "rank"; file: number; computed: number }[];
  file_problems: string[];
}

const score1to5 = (v: string) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

export function validateIdeaMatrix(text: string): MatrixReport {
  const lines = parseCsv(text);
  const file_problems: string[] = [];
  const rejected: MatrixReport["rejected"] = [];
  const h = lines.findIndex((l) => l[0]?.trim() === "Rank" && l[1]?.trim() === "Idea");
  if (h < 0)
    return {
      ok: false,
      note: null,
      rows: [],
      rejected,
      mismatches: [],
      file_problems: ["no header row starting Rank,Idea"],
    };
  const header = (lines[h] as string[]).map((c) => c.trim());
  if (HEADER.some((c, i) => header[i] !== c))
    file_problems.push(`header should be: ${HEADER.join(", ")}`);
  const note = h > 0 ? ((lines[0] as string[])[0]?.trim() ?? null) : null;
  const parsed: (MatrixRow & { fileScore: number; fileRank: number })[] = [];
  const seen = new Set<number>();
  for (let i = h + 1; i < lines.length; i++) {
    const l = (lines[i] as string[]).map((c) => c.trim());
    if (l.every((c) => !c)) continue;
    const line = i + 1;
    const [rank, idea, score, angle, fit, speed, demand, solo, list] = l;
    const s = [fit, speed, demand, solo].map((x) => score1to5(x ?? ""));
    const listNo = Number(list);
    if (!idea) rejected.push({ line, reason: "no idea" });
    else if (!angle) rejected.push({ line, reason: "no build angle" });
    else if (s.some((x) => x === null))
      rejected.push({ line, reason: "every score must be a whole number from 1 to 5" });
    else if (!Number.isInteger(listNo) || listNo < 1)
      rejected.push({ line, reason: "List # must be a whole number" });
    else if (seen.has(listNo)) rejected.push({ line, reason: `List # ${listNo} appears twice` });
    else {
      seen.add(listNo);
      const [f, sp, d, so] = s as number[];
      parsed.push({
        id: `R${String(listNo).padStart(3, "0")}`,
        list_no: listNo,
        rank: 0,
        idea,
        build_angle: angle,
        fit: f as number,
        speed_to_cash: sp as number,
        demand: d as number,
        solo_build: so as number,
        score: (f as number) + (sp as number) + (d as number) + (so as number),
        fileScore: Number(score),
        fileRank: Number(rank),
      });
    }
  }
  // Competition ranking on the recomputed score (ties share a rank; the next rank skips).
  const sorted = [...parsed].sort((a, b) => b.score - a.score);
  for (const r of parsed) r.rank = 1 + sorted.filter((x) => x.score > r.score).length;
  const mismatches: MatrixReport["mismatches"] = [];
  for (const r of parsed) {
    if (r.fileScore !== r.score)
      mismatches.push({ id: r.id, field: "score", file: r.fileScore, computed: r.score });
    if (r.fileRank !== r.rank)
      mismatches.push({ id: r.id, field: "rank", file: r.fileRank, computed: r.rank });
  }
  const rows = parsed
    .map(({ fileScore: _s, fileRank: _r, ...x }) => x)
    .sort((a, b) => a.rank - b.rank || a.list_no - b.list_no);
  return {
    ok: rejected.length === 0 && file_problems.length === 0 && rows.length > 0,
    note,
    rows,
    rejected,
    mismatches,
    file_problems,
  };
}

export class IdeaMatrixImportError extends Error {
  constructor(readonly report: MatrixReport) {
    super(
      `ideas matrix rejected: ${[...report.file_problems, ...report.rejected.map((r) => `line ${r.line}: ${r.reason}`)].join("; ")}`,
    );
  }
}

async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const same = (a: IdeaMatrixRow, b: MatrixRow) =>
  a.rank === b.rank &&
  a.idea === b.idea &&
  a.build_angle === b.build_angle &&
  a.score === b.score &&
  MATRIX_SCORES.every((k) => a[k] === b[k]);

/** Imports the matrix (idempotent on id). Recorded in the shared import log. */
export async function importIdeaMatrix(
  storage: Storage,
  text: string,
  o: { by: string; source?: string },
) {
  const report = validateIdeaMatrix(text);
  if (!report.ok) throw new IdeaMatrixImportError(report);
  const source = o.source ?? IDEA_MATRIX_PATH;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const r of report.rows) {
    const cur = await storage.ideaMatrix.get(r.id);
    if (cur && same(cur, r)) {
      unchanged++;
      continue;
    }
    await storage.ideaMatrix.put({ ...r, source, synthetic: false });
    if (cur) updated++;
    else created++;
  }
  await storage.hypotheses.recordImport({
    id: crypto.randomUUID(),
    source,
    source_hash: await sha256(text),
    rows: report.rows.length,
    created,
    updated,
    unchanged,
    imported_by: o.by,
  });
  return { rows: report.rows.length, created, updated, unchanged, mismatches: report.mismatches };
}
