import { describe, expect, it } from "vitest";
import { envKeyStore, FakeKeyStore, SecretsStoreKeyStore } from "./keys.ts";

const SECRET = "sk-canary-0123456789";

describe("KeyStore adapters", () => {
  it("fake and local stores save and report presence without echoing", async () => {
    const f = new FakeKeyStore();
    expect(await f.has("A_KEY")).toBe(false);
    await f.put("A_KEY", SECRET);
    expect(await f.has("A_KEY")).toBe(true);
    const l = envKeyStore({ FROM_ENV: "x" });
    expect(await l.has("FROM_ENV")).toBe(true);
    expect(await l.has("A_KEY")).toBe(false);
  });

  it("Secrets Store: reads a binding or a plain Worker secret; a missing secret reads as null", async () => {
    const s = new SecretsStoreKeyStore(
      {
        BOUND: { get: async () => "from-store" },
        MISSING: { get: async () => Promise.reject(new Error("not found")) },
        PLAIN: "from-worker-secret",
      },
      {},
    );
    expect(await s.reveal("BOUND")).toBe("from-store");
    expect(await s.reveal("PLAIN")).toBe("from-worker-secret");
    expect(await s.reveal("MISSING")).toBeNull();
    expect(await s.has("NOPE")).toBe(false);
  });

  it("Secrets Store: creates (POST array) or replaces (PATCH by id), with the narrow token; errors never carry the value", async () => {
    const calls: { url: string; method: string; body: string | null; auth: string }[] = [];
    let existing: { id: string; name: string }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: (init?.body as string) ?? null,
        auth: ((init?.headers ?? {}) as Record<string, string>).authorization ?? "",
      });
      if (method === "GET") return Response.json({ success: true, result: existing });
      if (method === "POST") return Response.json({ success: true, result: [{ id: "s1" }] });
      return new Response(JSON.stringify({ success: false, echoed: SECRET }), { status: 400 });
    }) as typeof fetch;
    const s = new SecretsStoreKeyStore(
      {},
      { accountId: "acc", storeId: "st", token: "tok", fetch: fakeFetch },
    );
    await s.put("EMAIL_API_KEY", SECRET);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/secrets_store/stores/st/secrets",
    );
    expect(JSON.parse(post?.body ?? "[]")[0]).toMatchObject({
      name: "EMAIL_API_KEY",
      scopes: ["workers"],
    });
    expect(post?.auth).toBe("Bearer tok");
    existing = [{ id: "s1", name: "EMAIL_API_KEY" }];
    const err = await s.put("EMAIL_API_KEY", SECRET).catch((e: Error) => e.message);
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: expect.stringMatching(/\/secrets\/s1$/),
    });
    expect(err).toMatch(/update failed \(HTTP 400\)/);
    expect(err).not.toContain(SECRET);
  });

  it("refuses to write without the account, store and token (and says what to set)", async () => {
    const s = new SecretsStoreKeyStore({}, {});
    await expect(s.put("X_KEY", SECRET)).rejects.toThrow(/CF_SECRETS_TOKEN/);
  });
});
