/**
 * Archie's review time (v2 unit economics). Counts only time the dashboard is visible. Each decision
 * records the visible time since the previous decision (or since the page opened), so time spent
 * reading an item is charged to the item decided next. Capped server-side at 4 hours per item.
 */
let activeMs = 0;
// Safe to import outside a browser (component tests render without a document).
const hasDocument = typeof document !== "undefined";
let visibleSince: number | null =
  hasDocument && document.visibilityState === "visible" ? Date.now() : null;
let startedAt = new Date().toISOString();

if (hasDocument)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") visibleSince = Date.now();
    else if (visibleSince !== null) {
      activeMs += Date.now() - visibleSince;
      visibleSince = null;
    }
  });

export type ReviewItemType =
  | "opportunity"
  | "draft"
  | "print_batch"
  | "conflict"
  | "quarantine"
  | "claim";

/** Records a review session for a decision; never blocks or fails the decision itself. */
export function recordReview(itemType: ReviewItemType, itemId: string, taskIds: string[] = []) {
  const now = Date.now();
  const ms = activeMs + (visibleSince !== null ? now - visibleSince : 0);
  const body = {
    item_type: itemType,
    item_id: itemId,
    task_ids: taskIds,
    started_at: startedAt,
    decided_at: new Date(now).toISOString(),
    active_ms: Math.min(Math.round(ms), 4 * 3_600_000),
  };
  activeMs = 0;
  visibleSince = document.visibilityState === "visible" ? now : null;
  startedAt = body.decided_at;
  fetch("/api/review-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}
