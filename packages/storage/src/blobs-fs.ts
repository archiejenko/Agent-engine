import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BlobStore } from "./blobs.ts";

/** Node only. Blobs as files under one folder (locally `data/blobs`). Keys can't escape the folder. */
export function fsBlobStore(root: string): BlobStore {
  const base = resolve(root);
  const path = (key: string) => {
    const p = resolve(join(base, key));
    if (!p.startsWith(base + sep)) throw new Error(`blob key escapes the folder: ${key}`);
    return p;
  };
  return {
    async put(key, body) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(path(key)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    async delete(key) {
      await rm(path(key), { force: true });
    },
  };
}
