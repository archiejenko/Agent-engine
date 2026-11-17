import type { GateCriterion } from "@ae/agent-runner";
import { IDEA_COLUMNS, writeAgentNote } from "@ae/infra";
import type { Storage } from "@ae/storage";
import { createApp } from "../app.ts";

/**
 * v3 Phase 4 gate: search by content, backlinks, agent writes as new versions (never replacing Archie's),
 * provenance on every agent note, and the ideas sheet shown with every score labelled assumed.
 * Fixture notes are injected; brain/ itself is untouched.
 */
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const IDEAS_FIXTURE = [
  IDEA_COLUMNS.join(","),
  [
    "I-001",
    "1",
    "Websites for trades",
    "4.2",
    "Quick win",
    "Services",
    "Tradespeople",
    "Setup + monthly",
    "Few have sites",
    "4",
    "5",
    "4",
    "4",
    "5",
    "4",
    "new",
    "",
    "",
    "1",
  ]
    .map(csvCell)
    .join(","),
  [
    "I-002",
    "2",
    'Company checks for agents, "pay per call"',
    "3.9",
    "Bet",
    "Data",
    "AI agents",
    "x402 per call",
    "Agents pay",
    "5",
    "3",
    "3",
    "5",
    "3",
    "3",
    "new",
    "",
    "Needs x402",
    "1",
  ]
    .map(csvCell)
    .join(","),
  [
    "I-003",
    "3",
    "Late-filing alerts",
    "3.1",
    "Later",
    "Data",
    "Accountants",
    "Monthly",
    "Penalties",
    "3",
    "3",
    "3",
    "3",
    "4",
    "4",
    "parked",
    "fail",
    "",
    "1",
  ]
    .map(csvCell)
    .join(","),
].join("\n");

export const VAULT_FIXTURE = [
  {
    path: "brain/frameworks/pricing.md",
    body: "---\ntype: framework\ntags: [pricing]\n---\n# Pricing\nOur zebra pricing rule lives here. See [[lessons]] and [the plan](../build-reports/plan.md).\n",
  },
  {
    path: "brain/lessons.md",
    body: "---\ntype: lesson\n---\n# Lessons\nShort letters beat long ones.\n",
  },
  { path: "brain/build-reports/plan.md", body: "# Plan\nNothing here links back.\n" },
  { path: "brain/ideas/seed-500.csv", body: IDEAS_FIXTURE },
];

export async function runV3Phase4Gate(storage: Storage) {
  const app = createApp({
    runtime: "node",
    storage: () => storage,
    vault: async () => VAULT_FIXTURE,
  });
  const get = async (p: string) =>
    (await app.request(p)).json() as Promise<Record<string, unknown>>;
  const put = (path: string, body: string) =>
    app.request("/api/vault/note", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, body }),
    });

  // 1. Search by content (a word only in the body).
  const found = (await get("/api/vault?search=zebra")) as { notes: { path: string }[] };
  const tagged = (await get("/api/vault?tag=pricing")) as { notes: { path: string }[] };

  // 2. Links and backlinks.
  const lessons = (await get(`/api/vault/note?path=${encodeURIComponent("brain/lessons.md")}`)) as {
    backlinks: string[];
  };
  const plan = (await get(
    `/api/vault/note?path=${encodeURIComponent("brain/build-reports/plan.md")}`,
  )) as { backlinks: string[] };
  const pricing = (await get(
    `/api/vault/note?path=${encodeURIComponent("brain/frameworks/pricing.md")}`,
  )) as { links: string[] };

  // 3. Archie edits; an agent writes later: a new version, Archie's text kept.
  const mine = "# Lessons\nShort letters beat long ones. Archie's own wording.\n";
  const edit = await put("brain/lessons.md", mine);
  await writeAgentNote(storage, {
    path: "brain/lessons.md",
    body: "# Lessons\nAgent summary of this week.\n",
    agent: "coordinator",
    sources: ["ledger:week-46"],
    ledger_rows: [12, 13],
  });
  await writeAgentNote(storage, {
    path: "brain/research/competitor.md",
    body: "# Competitor\nFrom their website.\n",
    agent: "researcher",
    sources: ["https://competitor.example"],
    labels: ["untrusted"],
  });
  const noProvenance = await writeAgentNote(storage, {
    path: "brain/research/bad.md",
    body: "x",
    agent: "researcher",
    sources: [],
  }).then(
    () => "accepted",
    (e: Error) => e.message,
  );
  const history = await storage.noteVersions.history("brain/lessons.md");
  const after = (await get(`/api/vault/note?path=${encodeURIComponent("brain/lessons.md")}`)) as {
    author: string;
    version: number;
  };
  const agentNotes = (await storage.noteVersions.latestAll()).filter((v) =>
    v.author.startsWith("agent:"),
  );
  const allAgentVersions = (
    await Promise.all(
      [...new Set(agentNotes.map((v) => v.path))].map((p) => storage.noteVersions.history(p)),
    )
  )
    .flat()
    .filter((v) => v.author.startsWith("agent:"));
  const list = (await get("/api/vault")) as { notes: { path: string; labels: string[] }[] };
  const competitor = list.notes.find((n) => n.path === "brain/research/competitor.md");

  // 4. The ideas sheet, every score assumed.
  const ideas = (await get("/api/vault/ideas")) as {
    present: boolean;
    missing: string[];
    rows: { kind: string; values: Record<string, string> }[];
  };

  const criteria: GateCriterion[] = [
    {
      criterion: "Search finds a note by its content (and by tag)",
      status:
        found.notes.length === 1 &&
        found.notes[0]?.path === "brain/frameworks/pricing.md" &&
        tagged.notes.length === 1
          ? "passed (synthetic)"
          : "failed",
      evidence: `"zebra" (only in the body) → ${found.notes.map((n) => n.path).join(", ")}; tag "pricing" → ${tagged.notes.length} note`,
    },
    {
      criterion: "Links and backlinks resolve ([[wikilinks]] and relative markdown links)",
      status:
        lessons.backlinks.includes("brain/frameworks/pricing.md") &&
        plan.backlinks.includes("brain/frameworks/pricing.md") &&
        pricing.links.length === 2
          ? "passed (synthetic)"
          : "failed",
      evidence: `pricing.md links to ${pricing.links.join(", ")}; lessons.md backlinks: ${lessons.backlinks.join(", ")}; plan.md backlinks: ${plan.backlinks.join(", ")}`,
    },
    {
      criterion: "An agent write creates a new version rather than replacing Archie's",
      status:
        edit.status === 200 &&
        history.length === 2 &&
        history[0]?.author === "archie" &&
        history[0]?.body === mine &&
        history[1]?.author === "agent:coordinator" &&
        after.version === 2
          ? "passed (synthetic)"
          : "failed",
      evidence: `history of lessons.md: ${history.map((h) => `v${h.version} ${h.author}`).join(", ")}; Archie's text is still v1, untouched`,
    },
    {
      criterion: "Provenance is present on every agent-written note (and labels carry through)",
      status:
        allAgentVersions.length === 2 &&
        allAgentVersions.every((v) => {
          const p = v.provenance as {
            author?: string;
            at?: string;
            sources?: string[];
            ledger_rows?: number[];
          };
          return Boolean(
            p?.author && p.at && ((p.sources?.length ?? 0) > 0 || (p.ledger_rows?.length ?? 0) > 0),
          );
        }) &&
        /needs its provenance/.test(noProvenance) &&
        competitor?.labels.includes("untrusted") === true
          ? "passed (synthetic)"
          : "failed",
      evidence: `${allAgentVersions.length} agent versions, each with author, time and sources/ledger rows; a note without provenance was refused ("${noProvenance}"); the note built on a website shows "untrusted"`,
    },
    {
      criterion: "The ideas sheet shows in the Vault with every score labelled assumed",
      status:
        ideas.present &&
        ideas.missing.length === 0 &&
        ideas.rows.length === 3 &&
        ideas.rows.every((r) => r.kind === "assumed") &&
        ideas.rows[1]?.values.Idea === 'Company checks for agents, "pay per call"'
          ? "passed (synthetic)"
          : "failed",
      evidence: `fixture sheet with Archie's columns: ${ideas.rows.length} rows, all labelled assumed; quoted cells parsed; scoring code never reads it (tests/architecture.test.ts)`,
    },
  ];
  return { criteria };
}
