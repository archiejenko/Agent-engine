import type { Storage } from "@ae/storage";
import { requestVerification } from "../../query.ts";

/**
 * Companies House Streaming API (Phase 4, Archie's addition). Change events for companies, officers,
 * PSCs, charges and filings arrive as a long-lived stream; each event for a company we track becomes a
 * re-verification request, so watched and queried companies stay current without polling.
 * The consumer stores the last timepoint per stream and resumes from it after a disconnect.
 * ASSUMPTIONS TO VERIFY at cutover: stream host stream.companieshouse.gov.uk, paths /companies,
 * /officers, /persons-with-significant-control, /charges, /filings; a separate STREAM key (Basic auth);
 * newline-delimited JSON with { resource_id, resource_uri, data, event: { timepoint, type, published_at } };
 * resume with ?timepoint=N.
 */
export type StreamName =
  | "companies"
  | "officers"
  | "persons-with-significant-control"
  | "charges"
  | "filings";

export interface StreamEvent {
  stream: StreamName;
  timepoint: number;
  type: string;
  published_at: string;
  resource_uri: string;
  company_number: string | null;
}

export interface ChangeStream {
  /** Yields events from `fromTimepoint` (exclusive) until the stream ends or `signal` aborts. */
  events(
    stream: StreamName,
    fromTimepoint: number | null,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

export const FIELDS_BY_STREAM: Record<StreamName, string[]> = {
  companies: [
    "company_status",
    "company_name",
    "registered_office_address",
    "registered_office_postcode",
    "sic_codes",
    "accounts_overdue",
    "insolvency_flags",
  ],
  officers: ["officers_active", "officer_appointments"],
  "persons-with-significant-control": ["psc_active", "psc_history"],
  charges: ["charges"],
  filings: ["filing_events", "last_accounts_made_up_to", "accounts_category"],
};

/** "/company/01234567/officers/abc" → "01234567" */
export function companyFromUri(uri: string): string | null {
  return uri.match(/\/company\/([A-Z0-9]{8})(?:\/|$)/i)?.[1]?.toUpperCase() ?? null;
}

/** Parse one NDJSON line from the real stream (blank keep-alive lines return null). */
export function parseStreamLine(stream: StreamName, line: string): StreamEvent | null {
  if (!line.trim()) return null;
  const j = JSON.parse(line) as {
    resource_uri?: string;
    event?: { timepoint?: number; type?: string; published_at?: string };
  };
  const uri = j.resource_uri ?? "";
  return {
    stream,
    timepoint: Number(j.event?.timepoint ?? 0),
    type: j.event?.type ?? "changed",
    published_at: j.event?.published_at ?? new Date().toISOString(),
    resource_uri: uri,
    company_number: companyFromUri(uri),
  };
}

export const timepointKey = (s: StreamName) => `stream:timepoint:${s}`;

/** Consume events: tracked companies → re-verification requests; timepoint saved as we go. */
export async function consumeStream(
  storage: Storage,
  source: ChangeStream,
  stream: StreamName,
  o: { max?: number; signal?: AbortSignal } = {},
) {
  const from = await storage.controls.get<number>(timepointKey(stream));
  let seen = 0;
  let requested = 0;
  let last = from;
  for await (const ev of source.events(stream, from, o.signal)) {
    seen++;
    last = ev.timepoint;
    if (ev.company_number && (await storage.entities.get(ev.company_number))) {
      await requestVerification(storage, {
        entities: [ev.company_number],
        fields: FIELDS_BY_STREAM[stream],
        reason: `stream:${stream}:${ev.type}`,
      });
      requested++;
    }
    if (seen % 100 === 0) await storage.controls.set(timepointKey(stream), last, "stream");
    if (o.max && seen >= o.max) break;
  }
  if (last !== null) await storage.controls.set(timepointKey(stream), last, "stream");
  return { seen, requested, timepoint: last };
}

/** Fake stream: scripted events, honouring the resume timepoint. */
export class FakeChangeStream implements ChangeStream {
  constructor(private readonly script: StreamEvent[]) {}
  async *events(stream: StreamName, from: number | null) {
    for (const e of this.script)
      if (e.stream === stream && (from === null || e.timepoint > from)) yield e;
  }
}

/** REAL stream (cutover; runs in the Node agent runner, not a Worker): long-lived NDJSON over HTTPS. */
export class HttpChangeStream implements ChangeStream {
  constructor(
    private readonly streamKey: string,
    private readonly base = "https://stream.companieshouse.gov.uk",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  async *events(stream: StreamName, from: number | null, signal?: AbortSignal) {
    const url = `${this.base}/${stream}${from !== null ? `?timepoint=${from + 1}` : ""}`;
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Basic ${btoa(`${this.streamKey}:`)}` },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) throw new Error(`stream ${stream}: HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const ev = parseStreamLine(stream, buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (ev) yield ev;
        i = buf.indexOf("\n");
      }
    }
  }
}
