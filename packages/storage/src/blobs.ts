/**
 * Large bodies and archives (data layer plan, steps 1 and 3). R2 on Cloudflare (`FILES`), a folder
 * locally (`data/blobs`, see `@ae/storage/fs`), memory in tests. Runtime-neutral.
 *
 * Callers outside `packages/storage` never use this directly for row bodies: they go through
 * `bodies.ts`, which decides inline-or-blob. The run archive is the one direct user.
 */
export interface BlobStore {
  put(key: string, body: Uint8Array | string, meta?: { contentType?: string }): Promise<void>;
  /** null when there's no such object. */
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Every key (tests and leak audits only; not on R2, where listing is paged and not needed). */
  list?(): Promise<string[]>;
}

export function memoryBlobStore(): BlobStore & { keys(): string[]; list(): Promise<string[]> } {
  const m = new Map<string, Uint8Array>();
  return {
    async put(key, body) {
      m.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body.slice());
    },
    async get(key) {
      return m.get(key)?.slice() ?? null;
    },
    async delete(key) {
      m.delete(key);
    },
    keys: () => [...m.keys()],
    list: async () => [...m.keys()],
  };
}

/** The R2 binding's shape, as far as we use it (so this file needs no Workers types). */
export interface R2Like {
  put(
    key: string,
    value: Uint8Array | string,
    o?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

export function r2BlobStore(bucket: R2Like): BlobStore {
  return {
    async put(key, body, meta) {
      await bucket.put(
        key,
        body,
        meta?.contentType ? { httpMetadata: { contentType: meta.contentType } } : undefined,
      );
    },
    async get(key) {
      const o = await bucket.get(key);
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
