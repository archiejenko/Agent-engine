import { type KeyEntry, type KeysConfig, loadKeysConfig } from "@ae/config";
import type { KeyStore, ModelClient, ModelRequest } from "@ae/ports";
import type { KeyRegistryRow, Storage } from "@ae/storage";

/**
 * Keys (v3 rule 20). Values are write-only: saved once into the KeyStore, never stored in D1, never
 * returned to a page, never placed in a model request, a log line or brain/. This file is the ONLY
 * caller of `KeyStore.reveal` (tests/architecture.test.ts):
 * - the tool registry asks `forTool` for the keys a tool declares, on a live call only, and scrubs every
 *   injected value out of the result, the error and the call log before anything else sees them;
 * - the model client is built with `modelKey` (the key goes in the request header, never the body).
 * A provider that refuses a key (`KeyFailedError`) marks it failing: a decision is raised and ONLY the
 * playbooks that depend on that key pause, until a new value is saved or Archie chooses to retry.
 */
export const REDACTED = "[key removed]";

/** Thrown by a tool (or the model wrapper) when the provider refused the key (e.g. HTTP 401/403). */
export class KeyFailedError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
  }
}

/** Deep-replaces every occurrence of each secret in strings inside `x`. */
export function scrub<T>(x: T, secrets: string[]): T {
  const live = secrets.filter((s) => s.length >= 4);
  if (live.length === 0) return x;
  const str = (v: string) => live.reduce((a, s) => a.split(s).join(REDACTED), v);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[str(k)] = walk(val);
      return out;
    }
    return v;
  };
  return walk(x) as T;
}

export interface KeyView {
  name: string;
  label: string;
  host: string;
  purpose: string;
  status: KeyRegistryRow["status"];
  saved: boolean;
  last_used_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  playbooks: string[];
  tools: string[];
  store: string;
}

export class KeyError extends Error {}

/** The names a key may be read under: its own, then its catalogue aliases (keys.json). */
export function keyNames(name: string, catalogue: KeysConfig = loadKeysConfig()): string[] {
  return [name, ...(catalogue.keys.find((k) => k.name === name)?.aliases ?? [])];
}

/** Reveals a key by name, falling back to its aliases. The only place aliases are applied. */
async function revealKey(store: KeyStore, name: string, catalogue: KeysConfig) {
  for (const n of keyNames(name, catalogue)) {
    const v = await store.reveal(n);
    if (v) return v;
  }
  return null;
}

/**
 * For hand-run Node scripts (no storage, no key registry): a key from the environment or .dev.vars,
 * by name or one of its aliases. The value goes straight into a client; it's never printed.
 */
export function keyFromEnv(
  name: string,
  env: Record<string, string | undefined>,
  catalogue: KeysConfig = loadKeysConfig(),
): string | null {
  for (const n of keyNames(name, catalogue)) if (env[n]) return env[n] as string;
  return null;
}

export class KeyRing {
  readonly catalogue: KeysConfig;
  constructor(
    private readonly store: KeyStore,
    private readonly storage: Storage,
    catalogue?: KeysConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.catalogue = catalogue ?? loadKeysConfig();
  }

  entry(name: string): KeyEntry | null {
    return this.catalogue.keys.find((k) => k.name === name) ?? null;
  }

  /** What the Keys page shows: status and dependants. There is no value field. */
  async list(): Promise<KeyView[]> {
    const rows = new Map((await this.storage.keyRegistry.list()).map((r) => [r.name, r]));
    const out: KeyView[] = [];
    for (const k of this.catalogue.keys) {
      const r = rows.get(k.name);
      let saved = false;
      for (const n of keyNames(k.name, this.catalogue)) if (!saved) saved = await this.store.has(n);
      out.push({
        name: k.name,
        label: k.label,
        host: k.host,
        purpose: k.purpose,
        status: r?.status ?? (saved ? "set" : "unset"),
        saved,
        last_used_at: r?.last_used_at ?? null,
        last_ok_at: r?.last_ok_at ?? null,
        last_error: r?.last_error ?? null,
        playbooks: k.playbooks,
        tools: k.tools,
        store: this.store.name,
      });
    }
    return out;
  }

  /** Archie saves a value. Returns nothing about it; a save clears "failing" (dependants resume). */
  async set(name: string, value: string, by: string): Promise<void> {
    const k = this.entry(name);
    if (!k) throw new KeyError("unknown_key");
    const v = value.trim();
    if (v.length < 8 || v.length > 4096 || /\s/.test(v)) throw new KeyError("invalid_value");
    try {
      await this.store.put(name, v);
    } catch (e) {
      throw new KeyError(scrub((e as Error).message, [v]));
    }
    await this.storage.keyRegistry.put(name, {
      status: "set",
      last_error: null,
      used_by: k.playbooks,
      updated_by: by,
    });
  }

  /**
   * The registry's injection point. Refuses (before anything happens) when a key is failing or missing.
   * Returns the values to pass to the handler and the list to scrub afterwards.
   */
  async forTool(keys: string[]): Promise<{ keys: Record<string, string>; secrets: string[] }> {
    const out: Record<string, string> = {};
    for (const name of keys) {
      const row = await this.storage.keyRegistry.get(name);
      if (row?.status === "failing")
        throw new KeyError(`key ${name} is failing; its playbooks are paused until it's replaced`);
      const v = await revealKey(this.store, name, this.catalogue);
      if (!v) {
        if (row?.status !== "unset")
          await this.storage.keyRegistry.put(name, {
            status: "unset",
            used_by: this.entry(name)?.playbooks ?? [],
          });
        throw new KeyError(`key ${name} isn't set (add it on Controls → Keys)`);
      }
      out[name] = v;
    }
    return { keys: out, secrets: Object.values(out) };
  }

  /** Records a use. A failure marks the key failing (the decision and the pause follow from that). */
  async used(name: string, ok: boolean, error?: string, secrets: string[] = []) {
    const at = this.now().toISOString();
    await this.storage.keyRegistry.put(name, {
      last_used_at: at,
      used_by: this.entry(name)?.playbooks ?? [],
      ...(ok
        ? { status: "ok", last_ok_at: at, last_error: null }
        : {
            status: "failing",
            last_error: scrub(error ?? "refused by the provider", secrets).slice(0, 300),
          }),
    });
  }

  /** The model client's key (header only). Null when unset. */
  async modelKey(): Promise<string | null> {
    const k = this.catalogue.keys.find((x) => x.model);
    return k ? revealKey(this.store, k.name, this.catalogue) : null;
  }
}

/** Playbooks paused because a key they depend on is failing (rule 20: only those). */
export async function playbooksPausedByKeys(
  storage: Storage,
  catalogue: KeysConfig = loadKeysConfig(),
): Promise<Map<string, string[]>> {
  const paused = new Map<string, string[]>();
  for (const r of await storage.keyRegistry.failing()) {
    const k = catalogue.keys.find((x) => x.name === r.name);
    for (const pb of k?.playbooks ?? r.used_by) paused.set(pb, [...(paused.get(pb) ?? []), r.name]);
  }
  return paused;
}

/**
 * Wraps the model client: an authentication refusal marks the model key failing. The key itself is in
 * the client's header only; requests and errors passing through here are scrubbed of it anyway.
 */
export function keyedModel(model: ModelClient, ring: KeyRing, key: string | null): ModelClient {
  const name = ring.catalogue.keys.find((k) => k.model)?.name ?? "ANTHROPIC_API_KEY";
  const secrets = key ? [key] : [];
  return {
    name: model.name,
    complete: async (req: ModelRequest) => {
      try {
        const r = await model.complete(scrub(req, secrets));
        if (key) await ring.used(name, true);
        return r;
      } catch (e) {
        const status = (e as { status?: number }).status;
        const msg = scrub((e as Error).message, secrets);
        if (status === 401 || status === 403) {
          await ring.used(name, false, msg);
          throw new KeyFailedError(name, msg);
        }
        throw new Error(msg);
      }
    },
  };
}
