import type { BlobStore } from "./blobs.ts";

/**
 * The ONE read/write path for large bodies (data layer plan, step 3; Archie's request). A body at or
 * under 8 KiB stays inline in its row; anything larger goes to the blob store (R2 `agent-engine-files`
 * on Cloudflare, `data/blobs` locally, memory in tests), and the row keeps only its key, size and
 * SHA-256. Letter PDFs and demo pages always go to the blob store.
 *
 * Only storage methods call this, so no caller ever sees a key or handles the two cases. A static test
 * fails if code outside this package reads a `*_key` body column.
 *
 * - Write order: the object first, then the row. If the row write fails, the orphan object is harmless.
 * - Reads check size and hash, and fail loudly on a mismatch or a missing object.
 * - Rule 20 (keys are scrubbed before anything is stored) happens before this, unchanged.
 */
export const INLINE_MAX_BYTES = 8 * 1024;

export type BodyKind =
  | "letter_pdf"
  | "demo_html"
  | "outbox"
  | "mail"
  | "note"
  | "runlog"
  | "run_output"
  | "source_fetch"
  | "brief";

/** What a row stores for one body. `inline` is "" when the body is in the blob store. */
export interface StoredBody {
  inline: string;
  key: string | null;
  size: number | null;
  sha256: string | null;
}

export class BodyIntegrityError extends Error {}

const ALWAYS_BLOB: ReadonlySet<BodyKind> = new Set(["letter_pdf", "demo_html"]);
const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256Hex(b: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", b as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

/** The object key for a body (one naming scheme, so a key says what it holds). */
export function bodyKey(kind: BodyKind, id: string, sha: string) {
  switch (kind) {
    case "letter_pdf":
      return `letters/${safe(id)}/${sha}.pdf`;
    case "demo_html":
      return `demo/${safe(id)}/${sha}.html`;
    case "outbox":
      return `outbox/${safe(id)}/${sha}`;
    case "mail":
      return `mail/${safe(id)}/${sha}`;
    case "note":
      return `notes/${safe(id)}-${sha}`;
    case "runlog":
      return `runlog/${safe(id)}-${sha}`;
    case "run_output":
      return `runs/${safe(id)}-${sha}`;
    case "source_fetch":
      return `sources/${safe(id)}-${sha}.json`;
    case "brief":
      return `briefs/${safe(id)}-${sha}`;
  }
}

export interface Bodies {
  /** Store a body: inline if small (and the kind allows it), otherwise in the blob store. */
  put(kind: BodyKind, id: string, content: string | Uint8Array): Promise<StoredBody>;
  /** The body as text, from the row or the blob store. */
  text(b: StoredBody): Promise<string>;
  /** The body as bytes (letter PDFs). */
  bytes(b: StoredBody): Promise<Uint8Array>;
}

export function makeBodies(blobs: BlobStore): Bodies {
  const fetch = async (b: StoredBody): Promise<Uint8Array> => {
    const key = b.key as string;
    const got = await blobs.get(key);
    if (!got) throw new BodyIntegrityError(`body object missing: ${key}`);
    if (b.size !== null && got.byteLength !== b.size)
      throw new BodyIntegrityError(`body ${key}: ${got.byteLength} bytes, expected ${b.size}`);
    if (b.sha256 && (await sha256Hex(got)) !== b.sha256)
      throw new BodyIntegrityError(`body ${key}: hash mismatch`);
    return got;
  };
  return {
    async put(kind, id, content) {
      const bytes = typeof content === "string" ? enc.encode(content) : content;
      if (
        !ALWAYS_BLOB.has(kind) &&
        typeof content === "string" &&
        bytes.byteLength <= INLINE_MAX_BYTES
      )
        return { inline: content, key: null, size: null, sha256: null };
      const sha = await sha256Hex(bytes);
      const key = bodyKey(kind, id, sha);
      await blobs.put(key, bytes, {
        contentType:
          kind === "letter_pdf"
            ? "application/pdf"
            : kind === "demo_html"
              ? "text/html; charset=utf-8"
              : "text/plain; charset=utf-8",
      });
      return { inline: "", key, size: bytes.byteLength, sha256: sha };
    },
    async text(b) {
      return b.key ? dec.decode(await fetch(b)) : b.inline;
    },
    async bytes(b) {
      return b.key ? fetch(b) : enc.encode(b.inline);
    },
  };
}

/** The stored-body columns of a row, for a body column named `col` (`col`, `col_key`, …). */
export function bodyOf(row: Record<string, unknown>, col: string): StoredBody {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    inline: (row[col] as string | null) ?? "",
    key: (row[`${col}_key`] as string | null) ?? null,
    size: n(row[`${col}_size`]),
    sha256: (row[`${col}_sha256`] as string | null) ?? null,
  };
}
