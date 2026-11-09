import { openSqliteStorage } from "@ae/storage/sqlite";

/**
 * For the screenshot record only. Opens a COPY of the seeded database (never the real one) and
 * allows external actions, because demo pages are only served while the kill switch is off. One
 * approved demo is aged past its 30-day expiry so the expired page can be captured. Nothing leaves
 * this machine: the local API uses fakes and the demo pages make no outbound requests.
 */
const path = process.argv[2];
if (!path?.includes("screens-public")) throw new Error("only ever run on the screens-public copy");
const s = await openSqliteStorage(path);
await s.controls.set("kill:global", false, "screens-public-copy");
const batches = await s.printBatches.list(20);
const approved = batches.find((b) => b.status === "approved");
const pending = batches.find((b) => b.status === "pending");
const approvedLetters = approved ? await s.letters.list({ batchId: approved.id }) : [];
const approvedOnes = approvedLetters.filter((l) => l.status === "approved");
// Only demos still inside their 30 days (the Phase 5 gate ages one itself to test expiry).
const live = [];
for (const l of approvedOnes) {
  const page = await s.demoPages.get(l.demo_slug);
  if (page?.published_at && Date.now() - Date.parse(page.published_at) < 29 * 86_400_000)
    live.push(l);
}
const [liveDemo, expiredDemo] = live;
if (expiredDemo)
  await s.demoPages.setPublished(
    [expiredDemo.demo_slug],
    true,
    new Date(Date.now() - 31 * 86_400_000).toISOString(),
  );
const conflicts = await s.facts.listCurrent({ status: "conflict", limit: 5, offset: 0 });
console.log(
  JSON.stringify({
    live_demo: liveDemo?.demo_slug ?? null,
    expired_demo: expiredDemo?.demo_slug ?? null,
    opt_out_code: live[2]?.opt_out_code ?? live[0]?.opt_out_code ?? null,
    pending_batch: pending?.id ?? null,
    conflict_entity: conflicts.rows[0]?.entity_id ?? null,
    conflict_field: conflicts.rows[0]?.field ?? null,
  }),
);
await s.close();
