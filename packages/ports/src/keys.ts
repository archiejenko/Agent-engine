/**
 * KeyStore port (v3 Phase 5, decision D4). Keys are WRITE-ONLY from the dashboard's point of view:
 * `put` saves a value; nothing returns it to a page. `reveal` exists only for the tool registry's
 * injection point (`packages/infra/src/keys.ts`; a static test keeps every other caller out).
 *
 * Adapters:
 * - `FakeKeyStore`: in memory (tests, gates).
 * - `envKeyStore`: local development; reads `.dev.vars`/process env, saves in memory for the session.
 * - `SecretsStoreKeyStore`: Cloudflare. Reads through Secrets Store bindings (`await env.X.get()`), or a
 *   plain Worker secret of the same name (the fallback during cutover). Writes go to the Secrets Store
 *   REST API with a token that has ONLY "Account Secrets Store Edit". Checked against current Cloudflare
 *   docs (2026-11-17): create = POST /accounts/{account}/secrets_store/stores/{store}/secrets with an
 *   array of {name, value, scopes, comment}; replace = PATCH .../secrets/{secret_id} with {value, scopes}.
 *   UNVERIFIED against the live API: the list call used to find an existing secret's id and the shape of
 *   its response (`result: [{ id, name }]`). Verify at cutover (docs/live-cutover.md, Stage 1b).
 */
export interface KeyStore {
  readonly name: string;
  /** True when a value is stored. Never returns the value. */
  has(key: string): Promise<boolean>;
  /** Saves a value. The value is never logged, echoed in an error or stored anywhere else. */
  put(key: string, value: string): Promise<void>;
  /** The tool registry's injection point only. */
  reveal(key: string): Promise<string | null>;
}

export class FakeKeyStore implements KeyStore {
  readonly name = "fake";
  private readonly values = new Map<string, string>();
  async has(key: string) {
    return this.values.has(key);
  }
  async put(key: string, value: string) {
    this.values.set(key, value);
  }
  async reveal(key: string) {
    return this.values.get(key) ?? null;
  }
}

/** Local: `.dev.vars` values (via process env), plus values saved from the Keys page for this session. */
export function envKeyStore(env: Record<string, string | undefined>): KeyStore {
  const saved = new Map<string, string>();
  return {
    name: "local",
    has: async (k) => saved.has(k) || Boolean(env[k]),
    put: async (k, v) => {
      saved.set(k, v);
    },
    reveal: async (k) => saved.get(k) ?? env[k] ?? null,
  };
}

/** A Secrets Store binding has a read-only `get()`; a Worker secret is a plain string. */
type Binding = string | { get(): Promise<string> } | undefined;

export class KeyStoreWriteError extends Error {}

export class SecretsStoreKeyStore implements KeyStore {
  readonly name = "cloudflare-secrets-store";
  constructor(
    private readonly env: Record<string, unknown>,
    private readonly api: {
      accountId?: string | undefined;
      storeId?: string | undefined;
      /** CF_SECRETS_TOKEN: "Account Secrets Store Edit" only. */
      token?: string | undefined;
      fetch?: typeof fetch;
    },
  ) {}

  async reveal(key: string): Promise<string | null> {
    const b = this.env[key] as Binding;
    if (typeof b === "string") return b || null;
    if (b && typeof b.get === "function") {
      try {
        return (await b.get()) || null;
      } catch {
        return null; // bound, but the secret doesn't exist yet
      }
    }
    return null;
  }

  async has(key: string) {
    return (await this.reveal(key)) !== null;
  }

  async put(key: string, value: string): Promise<void> {
    const { accountId, storeId, token } = this.api;
    if (!accountId || !storeId || !token)
      throw new KeyStoreWriteError(
        "saving keys from the dashboard needs CF_ACCOUNT_ID, SECRETS_STORE_ID and CF_SECRETS_TOKEN; until then set it with Wrangler",
      );
    const f = this.api.fetch ?? fetch;
    const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/secrets_store/stores/${storeId}/secrets`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    // Never include the response body in an error: it could echo the request.
    const check = async (r: Response, what: string) => {
      const ok =
        r.ok &&
        ((await r.json().catch(() => null)) as { success?: boolean } | null)?.success !== false;
      if (!ok) throw new KeyStoreWriteError(`Secrets Store ${what} failed (HTTP ${r.status})`);
    };
    // UNVERIFIED: list shape (see header).
    const list = await f(`${base}?per_page=100`, { headers });
    if (!list.ok) throw new KeyStoreWriteError(`Secrets Store list failed (HTTP ${list.status})`);
    const found = (
      ((await list.json()) as { result?: { id: string; name: string }[] }).result ?? []
    ).find((s) => s.name === key);
    if (found) {
      await check(
        await f(`${base}/${found.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ value, scopes: ["workers"] }),
        }),
        "update",
      );
    } else {
      await check(
        await f(base, {
          method: "POST",
          headers,
          body: JSON.stringify([
            {
              name: key,
              value,
              scopes: ["workers"],
              comment: "set from the Agent Engine Keys page",
            },
          ]),
        }),
        "create",
      );
    }
  }
}
