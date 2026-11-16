import type { InfraConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import { recordOutcome } from "./ledger.ts";

/**
 * Demo-page instrumentation (v2 Phase 1). A visit is logged when a live demo page is served: the slug,
 * whether it came from the printed QR code (`?s=qr`) or a typed link, and the time. No IP address, no
 * user agent, no cookies. A tiny inline script reports how long the page was visible when it's closed.
 */
export const DEMO_PRIVACY_LINE =
  "This sample page records that it was opened and for how long. No cookies are set and no IP address or device details are stored.";

/** Inline beacon: visible time only (pauses while the tab is hidden), sent once when the page closes. */
export const DEMO_BEACON_JS =
  "(function(){var t=0,s=document.visibilityState==='visible'?Date.now():0,d=false;" +
  "document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'){s=Date.now()}else{if(s){t+=Date.now()-s;s=0}send()}});" +
  "addEventListener('pagehide',function(){if(s){t+=Date.now()-s;s=0}send()});" +
  "function send(){if(d||!navigator.sendBeacon)return;d=true;navigator.sendBeacon(location.pathname.replace(/\\/$/,'')+'/t',String(t))}})();";

let beaconHash: Promise<string> | null = null;
/** CSP hash for the beacon, so the page still allows no other script. */
export function demoBeaconHash(): Promise<string> {
  beaconHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(DEMO_BEACON_JS))
    .then((b) => `sha256-${btoa(String.fromCharCode(...new Uint8Array(b)))}`);
  return beaconHash;
}

/** Adds the privacy line and the beacon to a stored demo page at serve time. */
export function instrumentDemoHtml(html: string, slug?: string): string {
  const claim = slug
    ? `<p><a class="cta" href="/claim/${encodeURIComponent(slug)}">Like it? Claim this site</a></p>`
    : "";
  const privacy = `${claim}<p class="legal">${DEMO_PRIVACY_LINE}</p>`;
  const withPrivacy = html.includes("</footer>")
    ? html.replace("</div></footer>", `${privacy}</div></footer>`)
    : html;
  return withPrivacy.replace("</body>", `<script>${DEMO_BEACON_JS}</script>\n</body>`);
}

export async function recordDemoVisit(
  storage: Storage,
  cfg: InfraConfig,
  slug: string,
  source: "qr" | "link",
  now: Date = new Date(),
): Promise<string | null> {
  const page = await storage.demoPages.get(slug);
  if (!page) return null;
  const task = await storage.tasks.get(page.task_id);
  const id = crypto.randomUUID();
  await storage.demoVisits.add({
    id,
    slug,
    entity_id: page.entity_id,
    task_id: page.task_id,
    source,
    visited_at: now.toISOString(),
    synthetic: task?.synthetic ?? false,
  });
  await recordOutcome(storage, cfg, {
    event: source === "qr" ? "qr_scan" : "demo_visit",
    entity_id: page.entity_id,
    task,
    source: "demo",
    dedupe_key: `demo:${id}`,
    observed_at: now.toISOString(),
  });
  // A QR scan is also a visit: the funnel counts both.
  if (source === "qr")
    await recordOutcome(storage, cfg, {
      event: "demo_visit",
      entity_id: page.entity_id,
      task,
      source: "demo",
      dedupe_key: `demo:${id}:visit`,
      observed_at: now.toISOString(),
    });
  return id;
}

/** The beacon: time on page for the latest open visit to this slug (within the configured window). */
export async function recordDemoTime(
  storage: Storage,
  cfg: InfraConfig,
  slug: string,
  ms: number,
  now: Date = new Date(),
): Promise<boolean> {
  if (!Number.isFinite(ms) || ms < 0) return false;
  const capped = Math.min(Math.round(ms), cfg.measurement.demo_visit_window_minutes * 60_000);
  const since = new Date(
    now.getTime() - cfg.measurement.demo_visit_window_minutes * 60_000,
  ).toISOString();
  const id = await storage.demoVisits.latestOpen(slug, since);
  if (!id) return false;
  await storage.demoVisits.setMs(id, capped);
  await storage.outcomeLedger.setMsOnPage(`demo:${id}`, capped);
  await storage.outcomeLedger.setMsOnPage(`demo:${id}:visit`, capped);
  return true;
}
