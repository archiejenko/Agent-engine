import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Deploy guard: the GitHub deploy token can publish this Worker but can't create resources. Any binding
// without a pinned id makes `wrangler deploy` try to create one and fail half-way, so every resource is
// created by hand first (runbook: docs/runbooks/deploy.md) and pinned here.

/** Strips // and /* *\/ comments outside strings, and trailing commas, so JSONC parses as JSON. */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

type Config = {
  name: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  d1_databases?: { binding: string; database_name: string; database_id?: string }[];
  kv_namespaces?: { binding: string; id?: string }[];
  r2_buckets?: { binding: string; bucket_name?: string }[];
  queues?: {
    producers?: { queue: string }[];
    consumers?: { queue: string; dead_letter_queue?: string }[];
  };
  durable_objects?: { bindings: { class_name: string; script_name?: string }[] };
  migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
  vars?: Record<string, string>;
};

const config = parseJsonc(
  readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8"),
) as Config;

describe("wrangler.jsonc deploy guard", () => {
  it("pins an id on every D1 database, so the deploy never has to create one", () => {
    for (const db of config.d1_databases ?? []) {
      expect(db.database_id, `D1 binding ${db.binding}`).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("pins an id on every KV namespace", () => {
    for (const kv of config.kv_namespaces ?? []) {
      expect(kv.id, `KV binding ${kv.binding}`).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("names every R2 bucket (no auto-created buckets)", () => {
    for (const r2 of config.r2_buckets ?? []) {
      expect(r2.bucket_name, `R2 binding ${r2.binding}`).toBeTruthy();
    }
  });

  it("binds FILES to the existing agent-engine-files bucket (created 2026-11-26)", () => {
    expect(config.r2_buckets).toEqual([{ binding: "FILES", bucket_name: "agent-engine-files" }]);
  });

  it("never binds an agent-house resource", () => {
    const names = [
      ...(config.d1_databases ?? []).map((d) => d.database_name),
      ...(config.r2_buckets ?? []).map((r) => r.bucket_name ?? ""),
      ...(config.queues?.producers ?? []).map((q) => q.queue),
      ...(config.queues?.consumers ?? []).flatMap((q) => [q.queue, q.dead_letter_queue ?? ""]),
    ];
    expect(config.name).toBe("agent-engine");
    for (const n of names) expect(n).not.toMatch(/agent-house/);
  });

  it("gives every Durable Object class a migration", () => {
    const migrated = new Set(
      (config.migrations ?? []).flatMap((m) => [
        ...(m.new_sqlite_classes ?? []),
        ...(m.new_classes ?? []),
      ]),
    );
    for (const b of config.durable_objects?.bindings ?? []) {
      if (!b.script_name) expect(migrated.has(b.class_name), b.class_name).toBe(true);
    }
  });

  it("keeps the only public hostname behind Access", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    // access.ts builds `${teamDomain}/cdn-cgi/access/certs` and checks the JWT issuer against it.
    expect(config.vars?.ACCESS_TEAM_DOMAIN).toMatch(
      /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/,
    );
    expect(config.vars?.ACCESS_POLICY_AUD).toMatch(/^[0-9a-f]{64}$/);
  });
});
