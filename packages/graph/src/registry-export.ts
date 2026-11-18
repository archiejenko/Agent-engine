import type { GraphPolicy, ModelsConfig } from "@ae/config";
import type { Autonomy, Role, ToolRegistration } from "@ae/contracts";
import { FUNCTION_CATALOGUE, type FunctionDef } from "./functions.ts";

/**
 * The node library: everything a graph may reference, exported from the live registries (graph plan,
 * G0). The planner receives this; the compiler checks every ref against it. Its hash is the registry
 * version stamped on every compiled graph (same inputs → same hash).
 */
export interface PlaybookCatalogueEntry {
  name: string;
  version: number;
  autonomy: Autonomy;
  revenue_path: string;
  /** The playbook's steps (a role node bound to a step uses that step's tools). */
  steps?: (
    | { id: string; role: Role; tools: string[]; output: string }
    | { id: string; gate: string }
  )[];
  /** Filled from run history (G5); zero until then. */
  stats: { runs: number; success_rate: number | null; avg_cost_gbp: number | null };
}

export interface NodeLibrary {
  registryVersion: string;
  kinds: string[];
  roles: { ref: Role; model: string; usd_per_mtok: { input: number; output: number } }[];
  tools: {
    ref: string;
    description: string;
    acts_externally: boolean;
    serves_customer: boolean;
    allowed_lanes: string[];
    allowed_roles: string[];
    rate_limit_per_min: number;
    cost_gbp_per_call: number;
    keys: string[];
  }[];
  functions: FunctionDef[];
  subgraphs: PlaybookCatalogueEntry[];
  approvals: { ref: "archie" }[];
  waits: string[];
  limits: GraphPolicy["limits"];
}

const ROLES: Role[] = ["researcher", "writer", "checker", "operator"];
const WAITS = ["sleep", "event:reply", "event:payment", "event:details"];

/** Canonical JSON: sorted keys, so the same library always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function exportNodeLibrary(o: {
  tools: ToolRegistration[];
  models: ModelsConfig;
  playbooks: PlaybookCatalogueEntry[];
  policy: GraphPolicy;
}): Promise<NodeLibrary> {
  const body: Omit<NodeLibrary, "registryVersion"> = {
    kinds: [
      "role",
      "tool",
      "function",
      "subgraph",
      "approval",
      "fanout",
      "join",
      "condition",
      "wait",
    ],
    roles: ROLES.map((ref) => {
      // The operator role never calls a model (it only calls external tools).
      const model =
        (o.models.roles as Record<string, { model: string } | undefined>)[ref]?.model ?? "none";
      const p = o.models.prices[model];
      return {
        ref,
        model,
        usd_per_mtok: { input: p?.input_usd_per_mtok ?? 0, output: p?.output_usd_per_mtok ?? 0 },
      };
    }),
    tools: [...o.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        ref: t.name,
        description: t.description,
        acts_externally: t.external,
        serves_customer: t.serves_customer,
        allowed_lanes: [...t.allowed_lanes],
        allowed_roles: [...t.allowed_roles],
        rate_limit_per_min: t.rate_limit_per_min,
        cost_gbp_per_call: t.cost_gbp_per_call,
        keys: [...(t.keys ?? [])],
      })),
    functions: [...FUNCTION_CATALOGUE].sort((a, b) => a.id.localeCompare(b.id)),
    subgraphs: [...o.playbooks].sort((a, b) =>
      `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
    ),
    approvals: [{ ref: "archie" }],
    waits: WAITS,
    limits: o.policy.limits,
  };
  return { registryVersion: (await sha256Hex(canonicalJson(body))).slice(0, 16), ...body };
}
