import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryBlobStore } from "../blobs.ts";
import { BodyIntegrityError, INLINE_MAX_BYTES, makeBodies } from "../bodies.ts";
import { openSqliteStorage } from "../sqlite.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const big = (n = INLINE_MAX_BYTES + 1) => "x".repeat(n);

describe("bodies: the one inline-or-R2 helper (data layer plan, step 3)", () => {
  it("keeps 8 KiB or less inline and puts anything larger in the blob store", async () => {
    const blobs = memoryBlobStore();
    const b = makeBodies(blobs);
    const small = await b.put("outbox", "m1", big(INLINE_MAX_BYTES));
    expect(small).toEqual({ inline: big(INLINE_MAX_BYTES), key: null, size: null, sha256: null });
    const large = await b.put("outbox", "m2", big());
    expect(large.inline).toBe("");
    expect(large.key).toMatch(/^outbox\/m2\/[0-9a-f]{64}$/);
    expect(large.size).toBe(INLINE_MAX_BYTES + 1);
    expect(await b.text(large)).toBe(big());
    expect(await b.text(small)).toBe(big(INLINE_MAX_BYTES));
    expect(blobs.keys()).toEqual([large.key]);
  });

  it("always puts letter PDFs and demo pages in the blob store, however small", async () => {
    const b = makeBodies(memoryBlobStore());
    expect((await b.put("demo_html", "acme", "<p>hi</p>")).key).toMatch(/^demo\/acme\/.+\.html$/);
    const pdf = await b.put("letter_pdf", "t1", new Uint8Array([37, 80, 68, 70]));
    expect(pdf.key).toMatch(/^letters\/t1\/.+\.pdf$/);
    expect([...(await b.bytes(pdf))]).toEqual([37, 80, 68, 70]);
  });

  it("checks size and hash on read and fails loudly on a mismatch or a missing object", async () => {
    const blobs = memoryBlobStore();
    const b = makeBodies(blobs);
    const s = await b.put("mail", "m", big());
    await blobs.put(s.key as string, `${big()}!`);
    await expect(b.text(s)).rejects.toThrow(BodyIntegrityError);
    await blobs.put(s.key as string, big().replace(/x$/, "y"));
    await expect(b.text(s)).rejects.toThrow(/hash mismatch/);
    await blobs.delete(s.key as string);
    await expect(b.text(s)).rejects.toThrow(/missing/);
  });
});

describe("storage bodies end to end", () => {
  it("every body kind round-trips through storage, large ones via the blob store", async () => {
    const blobs = memoryBlobStore();
    const s = await openSqliteStorage(":memory:", { blobs });
    const id = await s.outbox.add({
      task_id: null,
      thread_id: "th",
      attempt: 1,
      entity_id: "01234567",
      recipient: "a@b.example",
      sender: "me@x.example",
      subject: "s",
      body: big(),
      status: "dry_run",
      reason: null,
    });
    expect((await s.outbox.get(id))?.body).toBe(big());
    expect((await s.outbox.list(10))[0]?.body).toBe(big());
    await s.mail.add({
      id: "m1",
      folder: "inbox",
      from: "a@b.example",
      to: "me@x.example",
      subject: "s",
      body: big(),
      untrusted: true,
      received_at: "2026-11-26T00:00:00Z",
    });
    expect((await s.mail.get("m1"))?.body).toBe(big());
    await s.noteVersions.add({
      path: "brain/x.md",
      body: big(),
      author: "agent",
      provenance: null,
    });
    expect((await s.noteVersions.history("brain/x.md"))[0]?.body).toBe(big());
    await s.demoPages.put({
      slug: "acme",
      entity_id: "01234567",
      task_id: "t",
      html: "<p>demo</p>",
    });
    expect((await s.demoPages.get("acme"))?.html).toBe("<p>demo</p>");
    const task = crypto.randomUUID();
    await s.runLog.append({
      task_id: task,
      step_id: "fetch",
      role: "researcher",
      model: null,
      tool_calls: [],
      output: { page: big() },
      check_result: null,
      tokens: { input: 0, output: 0 },
      cost_gbp: 0,
      duration_ms: 1,
      timestamp: "2026-11-26T00:00:00.000Z",
    });
    expect((await s.runLog.forTask(task))[0]?.output).toEqual({ page: big() });
    const keys = blobs.keys();
    expect(keys.some((k) => k.startsWith("runlog/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("outbox/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("mail/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("notes/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("demo/acme/"))).toBe(true);
    // Rule 20's leak audit looks inside stored bodies too.
    expect(await s.audit.tablesContaining(`${big()}`.slice(0, 50))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^blob:outbox\//)]),
    );
  });
});

describe("only storage handles body keys", () => {
  it("no code outside packages/storage reads a *_key body column", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        if (/node_modules|dist|\.git$/.test(p)) return [];
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
      });
    const files = ["apps", "packages", "scripts"]
      .flatMap((d) => walk(join(ROOT, d)))
      .map((p) => relative(ROOT, p))
      .filter((f) => !f.startsWith("packages/storage/src/") && !f.endsWith(".generated.ts"));
    const offenders = files.filter((f) =>
      /\b(body_key|html_key|pdf_b64_key|recorded_model_output_key)\b/.test(
        readFileSync(join(ROOT, f), "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
