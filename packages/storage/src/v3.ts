import type { BlobStore } from "./blobs.ts";
import { type Bodies, bodyOf } from "./bodies.ts";
import type { SqlDriver, SqlValue } from "./driver.ts";
import { type LedgerRow, toLedger } from "./v2.ts";

/**
 * v3 Milestone C storage: grouped activity per company for the CRM (a few GROUP BY queries instead of
 * per-company lookups), and ledger rows in a date range for Home.
 */
type Row = Record<string, unknown>;

export interface CompanyActivity {
  entity_id: string;
  name: string | null;
  /** Latest time of each ledger event for this company (sent, reply, paid, churned, …). */
  events: Record<string, string>;
  letters: Record<string, number>;
  claim: { status: string; monthly_gbp: number; updated_at: string } | null;
  opted_out: boolean;
  opportunity: { expected_value_gbp: number; status: string; module: string } | null;
  open_tasks: { task_id: string; playbook: string; status: string; updated_at: string }[];
  synthetic: boolean;
}

export interface DecisionOption {
  key: string;
  label: string;
  /** Plain-English effect, shown under the button. */
  effect: string;
}
export type DecisionStatus = "open" | "decided" | "defaulted" | "superseded";
export interface DecisionRow {
  id: string;
  type: string;
  source_ref: string;
  summary: string;
  money_at_stake_gbp: number;
  money_kind: "real" | "estimated" | "assumed" | "none";
  options: DecisionOption[];
  recommended: string;
  safe_default: string;
  deadline: string;
  context: unknown;
  status: DecisionStatus;
  chosen_option: string | null;
  decided_by: string | null;
  approval_id: string | null;
  error: string | null;
  synthetic: boolean;
  created_at: string;
  decided_at: string | null;
}
const pj = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(v as string));
const toDecision = (r: Row): DecisionRow => ({
  id: r.id as string,
  type: r.type as string,
  source_ref: r.source_ref as string,
  summary: r.summary as string,
  money_at_stake_gbp: Number(r.money_at_stake_gbp),
  money_kind: r.money_kind as DecisionRow["money_kind"],
  options: pj(r.options) as DecisionOption[],
  recommended: r.recommended as string,
  safe_default: r.safe_default as string,
  deadline: r.deadline as string,
  context: pj(r.context),
  status: r.status as DecisionStatus,
  chosen_option: (r.chosen_option as string | null) ?? null,
  decided_by: (r.decided_by as string | null) ?? null,
  approval_id: (r.approval_id as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  synthetic: Number(r.synthetic) === 1,
  created_at: r.created_at as string,
  decided_at: (r.decided_at as string | null) ?? null,
});

export interface MailRow {
  id: string;
  folder: "inbox" | "drafts";
  from: string;
  to: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  entity_id: string | null;
  task_id: string | null;
  untrusted: boolean;
  author: string | null;
  received_at: string;
  synthetic: boolean;
}
const toMail = (r: Row): MailRow => ({
  id: r.id as string,
  folder: r.folder as MailRow["folder"],
  from: r.from_addr as string,
  to: r.to_addr as string,
  subject: r.subject as string,
  body: r.body as string,
  in_reply_to: (r.in_reply_to as string | null) ?? null,
  entity_id: (r.entity_id as string | null) ?? null,
  task_id: (r.task_id as string | null) ?? null,
  untrusted: Number(r.untrusted) === 1,
  author: (r.author as string | null) ?? null,
  received_at: r.received_at as string,
  synthetic: Number(r.synthetic) === 1,
});

export interface NoteVersionRow {
  path: string;
  version: number;
  body: string;
  author: string;
  provenance: unknown;
  created_at: string;
}
const toNoteVersion = (r: Row): NoteVersionRow => ({
  path: r.path as string,
  version: Number(r.version),
  body: r.body as string,
  author: r.author as string,
  provenance: pj(r.provenance),
  created_at: r.created_at as string,
});

export type KeyStatus = "unset" | "set" | "ok" | "failing";
/** A key's status. There is deliberately no value field: values never reach the database. */
export interface KeyRegistryRow {
  name: string;
  status: KeyStatus;
  last_used_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  used_by: string[];
  updated_at: string;
  updated_by: string | null;
}

export const SCORE_FIELDS = [
  "autonomy",
  "speed_to_cash",
  "demand",
  "margin",
  "ease_of_build",
  "low_risk",
] as const;
export type ScoreField = (typeof SCORE_FIELDS)[number];
export type IdeaScores = Record<ScoreField, number>;
export type IdeaMatrix = "Do first" | "Big bet" | "Quick win" | "Park";

/** A seeded idea as a hypothesis. Its scores are estimates (rule 23), never outcomes. */
export interface HypothesisRow extends IdeaScores {
  id: string;
  rank: number;
  idea: string;
  category: string;
  taxonomy_node: string | null;
  buyer: string;
  revenue_model: string;
  why_now: string;
  batch: string;
  score: number;
  matrix: IdeaMatrix;
  score_source: "estimate";
  file_status: "New" | "Built";
  stage: string;
  stage_changed_by: string | null;
  decision: "Pass" | "Fail" | "Question" | null;
  decision_by: string | null;
  decision_at: string | null;
  failed_fingerprint: string | null;
  comments: string | null;
  /** A node in brain/taxonomy.md, or "own product". */
  function: string | null;
  function_source: "category" | "estimate" | "set" | null;
  function_changed_by: string | null;
  market_buyer: string | null;
  market_industry: string | null;
  synthetic: boolean;
  created_at: string;
  updated_at: string;
}
export interface ScoreHistoryRow {
  id: number;
  hypothesis_id: string;
  field: ScoreField;
  old_value: number | null;
  new_value: number;
  changed_by: string;
  reason: string;
  changed_at: string;
}

export function v3Storage(db: SqlDriver, bodies: Bodies, blobs: BlobStore) {
  const all = (sql: string, args: SqlValue[] = []) => db.all<Row>(sql, args);
  const nowIso = () => new Date().toISOString();
  const mailRows = async (rows: Row[]) => {
    const out: MailRow[] = [];
    for (const r of rows) out.push({ ...toMail(r), body: await bodies.text(bodyOf(r, "body")) });
    return out;
  };
  const noteRows = async (rows: Row[]) => {
    const out: NoteVersionRow[] = [];
    for (const r of rows)
      out.push({ ...toNoteVersion(r), body: await bodies.text(bodyOf(r, "body")) });
    return out;
  };
  return {
    decisions: {
      /** Opens a decision unless one is already open for (type, source_ref). Returns the open one. */
      open: async (
        d: Omit<
          DecisionRow,
          | "id"
          | "status"
          | "chosen_option"
          | "decided_by"
          | "approval_id"
          | "error"
          | "created_at"
          | "decided_at"
        >,
      ): Promise<DecisionRow> => {
        await db.run(
          `INSERT OR IGNORE INTO decisions (id, type, source_ref, summary, money_at_stake_gbp, money_kind, options, recommended, safe_default, deadline, context, status, synthetic, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
          [
            crypto.randomUUID(),
            d.type,
            d.source_ref,
            d.summary,
            d.money_at_stake_gbp,
            d.money_kind,
            JSON.stringify(d.options),
            d.recommended,
            d.safe_default,
            d.deadline,
            d.context === undefined ? null : JSON.stringify(d.context),
            d.synthetic ? 1 : 0,
            nowIso(),
          ],
        );
        const r = (
          await all(
            "SELECT * FROM decisions WHERE type = ? AND source_ref = ? AND status = 'open'",
            [d.type, d.source_ref],
          )
        )[0];
        return toDecision(r as Row);
      },
      get: async (id: string) => {
        const r = (await all("SELECT * FROM decisions WHERE id = ?", [id]))[0];
        return r ? toDecision(r) : null;
      },
      openFor: async (type: string, sourceRef: string) => {
        const r = (
          await all(
            "SELECT * FROM decisions WHERE type = ? AND source_ref = ? AND status = 'open'",
            [type, sourceRef],
          )
        )[0];
        return r ? toDecision(r) : null;
      },
      /** Open decisions, highest money at stake first, then the nearest deadline. */
      list: async (o: { status?: DecisionStatus; type?: string; limit?: number } = {}) => {
        const where: string[] = [];
        const args: SqlValue[] = [];
        if (o.status) {
          where.push("status = ?");
          args.push(o.status);
        }
        if (o.type) {
          where.push("type = ?");
          args.push(o.type);
        }
        return (
          await all(
            `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, money_at_stake_gbp DESC, deadline ASC, created_at ASC LIMIT ?`,
            [...args, o.limit ?? 200],
          )
        ).map(toDecision);
      },
      /** Closes an open decision exactly once. False if it wasn't open (already decided elsewhere). */
      close: async (
        id: string,
        c: {
          status: Exclude<DecisionStatus, "open">;
          chosen_option: string | null;
          decided_by: string;
          approval_id?: string | null;
        },
      ) =>
        (
          await db.run(
            "UPDATE decisions SET status = ?, chosen_option = ?, decided_by = ?, approval_id = ?, decided_at = ? WHERE id = ? AND status = 'open'",
            [c.status, c.chosen_option, c.decided_by, c.approval_id ?? null, nowIso(), id],
          )
        ).changes === 1,
      setError: async (id: string, error: string) => {
        await db.run("UPDATE decisions SET error = ? WHERE id = ?", [error, id]);
      },
      /**
       * TEST WORLD ONLY (cockpit U3): marks decisions built from simulated data as simulated, so the
       * cockpit hides them unless "Include simulated" is on. Real decisions must never be marked: that
       * would hide them from Archie. tests/architecture.test.ts allows calls only from the test world.
       */
      markSynthetic: async (ids: string[]) => {
        for (const id of ids) await db.run("UPDATE decisions SET synthetic = 1 WHERE id = ?", [id]);
      },
      /** The latest closed decisions (decided or defaulted), newest first, from the decided_at index. */
      recentClosed: async (limit: number) =>
        (
          await all(
            "SELECT * FROM decisions WHERE decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT ?",
            [limit],
          )
        ).map(toDecision),
      expired: async (now: string) =>
        (
          await all(
            "SELECT * FROM decisions WHERE status = 'open' AND deadline <= ? ORDER BY deadline",
            [now],
          )
        ).map(toDecision),
      openCount: async () =>
        Number((await all("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'"))[0]?.n ?? 0),
      since: async (sinceIso: string) =>
        (
          await all("SELECT * FROM decisions WHERE decided_at >= ? ORDER BY decided_at", [sinceIso])
        ).map(toDecision),
    },

    mail: {
      add: async (m: {
        id: string;
        folder: "inbox" | "drafts";
        from: string;
        to: string;
        subject: string;
        body: string;
        in_reply_to?: string | null;
        entity_id?: string | null;
        task_id?: string | null;
        untrusted: boolean;
        author?: string | null;
        received_at: string;
        synthetic?: boolean;
      }) => {
        const body = await bodies.put("mail", m.id, m.body);
        await db.run(
          `INSERT OR IGNORE INTO mail_messages (id, folder, from_addr, to_addr, subject, body, body_key, body_size, body_sha256, in_reply_to, entity_id, task_id, untrusted, author, received_at, synthetic)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.id,
            m.folder,
            m.from,
            m.to,
            m.subject,
            body.inline,
            body.key,
            body.size,
            body.sha256,
            m.in_reply_to ?? null,
            m.entity_id ?? null,
            m.task_id ?? null,
            m.untrusted ? 1 : 0,
            m.author ?? null,
            m.received_at,
            m.synthetic ? 1 : 0,
          ],
        );
      },
      list: async (o: {
        folder: "inbox" | "drafts";
        limit: number;
        since?: string;
        includeSynthetic?: boolean;
      }) =>
        mailRows(
          await all(
            `SELECT * FROM mail_messages WHERE folder = ? AND received_at >= ?${o.includeSynthetic === false ? " AND synthetic = 0" : ""} ORDER BY received_at DESC LIMIT ?`,
            [o.folder, o.since ?? "", o.limit],
          ),
        ),
      get: async (id: string) => {
        const r = (await all("SELECT * FROM mail_messages WHERE id = ?", [id]))[0];
        return r ? ((await mailRows([r]))[0] as MailRow) : null;
      },
    },

    noteVersions: {
      /** Appends a version (never updates one). Returns its number. */
      add: async (v: { path: string; body: string; author: string; provenance: unknown }) => {
        const last = Number(
          (await all("SELECT MAX(version) AS v FROM note_versions WHERE path = ?", [v.path]))[0]
            ?.v ?? 0,
        );
        const body = await bodies.put("note", `${v.path}/${last + 1}`, v.body);
        await db.run(
          "INSERT INTO note_versions (id, path, version, body, body_key, body_size, body_sha256, author, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            crypto.randomUUID(),
            v.path,
            last + 1,
            body.inline,
            body.key,
            body.size,
            body.sha256,
            v.author,
            v.provenance === undefined ? null : JSON.stringify(v.provenance),
            nowIso(),
          ],
        );
        return last + 1;
      },
      history: async (path: string) =>
        noteRows(await all("SELECT * FROM note_versions WHERE path = ? ORDER BY version", [path])),
      latestAll: async () =>
        noteRows(
          await all(
            `SELECT n.* FROM note_versions n JOIN (SELECT path, MAX(version) AS v FROM note_versions GROUP BY path) m
             ON m.path = n.path AND m.v = n.version`,
          ),
        ),
    },

    audit: {
      /**
       * Leak checks (v3 rule 20): the names of tables with any row containing `needle`. Scans every table,
       * so it's for tests and gates, not request paths.
       */
      tablesContaining: async (needle: string): Promise<string[]> => {
        // Every store, not just core (data layer plan, step 2): a leak in facts or telemetry counts too.
        const stores = (db as { stores?: Record<string, SqlDriver | undefined> }).stores;
        const drivers = [...new Set(stores ? Object.values(stores) : [db])].filter(
          (d): d is SqlDriver => !!d,
        );
        const hits: string[] = [];
        for (const d of drivers) {
          const tables = (
            await d.all<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
            )
          ).map((r) => r.name);
          for (const t of tables) {
            const rows = await d.all(`SELECT * FROM "${t.replace(/"/g, "")}"`);
            if (rows.some((r) => JSON.stringify(r).includes(needle))) hits.push(t);
          }
        }
        // …and every stored body object (data layer plan, step 3), where the store can list them.
        for (const key of (await blobs.list?.()) ?? []) {
          const b = await blobs.get(key);
          if (b && new TextDecoder().decode(b).includes(needle)) hits.push(`blob:${key}`);
        }
        hits.sort();
        return hits;
      },
    },

    hypotheses: {
      get: async (id: string): Promise<HypothesisRow | null> => {
        const r = (await all("SELECT * FROM hypotheses WHERE id = ?", [id]))[0];
        return r ? toHyp(r) : null;
      },
      list: async (o: { limit?: number; offset?: number } = {}): Promise<HypothesisRow[]> =>
        (
          await all("SELECT * FROM hypotheses ORDER BY rank, id LIMIT ? OFFSET ?", [
            o.limit ?? 1000,
            o.offset ?? 0,
          ])
        ).map(toHyp),
      count: async (): Promise<number> =>
        Number((await all("SELECT COUNT(*) AS n FROM hypotheses"))[0]?.n ?? 0),
      /** Writes the whole row (insert or replace). Callers decide which fields an import may touch. */
      put: async (h: Omit<HypothesisRow, "created_at" | "updated_at">): Promise<void> => {
        const now = nowIso();
        const cols = [
          "id",
          "rank",
          "idea",
          "category",
          "taxonomy_node",
          "buyer",
          "revenue_model",
          "why_now",
          "batch",
          ...SCORE_FIELDS,
          "score",
          "matrix",
          "score_source",
          "file_status",
          "stage",
          "stage_changed_by",
          "decision",
          "decision_by",
          "decision_at",
          "failed_fingerprint",
          "comments",
          "function",
          "function_source",
          "function_changed_by",
          "market_buyer",
          "market_industry",
          "synthetic",
        ] as const;
        const vals = cols.map((c) =>
          c === "synthetic"
            ? h.synthetic
              ? 1
              : 0
            : ((h as unknown as Record<string, SqlValue>)[c] ?? null),
        );
        await db.run(
          `INSERT INTO hypotheses (${cols.join(", ")}, created_at, updated_at) VALUES (${cols.map(() => "?").join(", ")}, ?, ?)
           ON CONFLICT (id) DO UPDATE SET ${cols
             .filter((c) => c !== "id")
             .map((c) => `${c} = excluded.${c}`)
             .join(", ")}, updated_at = excluded.updated_at`,
          [...vals, now, now],
        );
      },
      addHistory: async (r: Omit<ScoreHistoryRow, "id" | "changed_at">): Promise<void> => {
        await db.run(
          "INSERT INTO hypothesis_score_history (hypothesis_id, field, old_value, new_value, changed_by, reason, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [r.hypothesis_id, r.field, r.old_value, r.new_value, r.changed_by, r.reason, nowIso()],
        );
      },
      history: async (id: string): Promise<ScoreHistoryRow[]> =>
        (
          await all("SELECT * FROM hypothesis_score_history WHERE hypothesis_id = ? ORDER BY id", [
            id,
          ])
        ).map((r) => ({
          id: Number(r.id),
          hypothesis_id: r.hypothesis_id as string,
          field: r.field as ScoreField,
          old_value: r.old_value === null ? null : Number(r.old_value),
          new_value: Number(r.new_value),
          changed_by: r.changed_by as string,
          reason: r.reason as string,
          changed_at: r.changed_at as string,
        })),
      recordImport: async (r: {
        id: string;
        source: string;
        source_hash: string;
        rows: number;
        created: number;
        updated: number;
        unchanged: number;
        imported_by: string;
      }): Promise<void> => {
        await db.run(
          "INSERT INTO hypothesis_imports (id, source, source_hash, rows, created, updated, unchanged, imported_by, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            r.id,
            r.source,
            r.source_hash,
            r.rows,
            r.created,
            r.updated,
            r.unchanged,
            r.imported_by,
            nowIso(),
          ],
        );
      },
      lastImport: async () => {
        const r = (
          await all("SELECT * FROM hypothesis_imports ORDER BY imported_at DESC LIMIT 1")
        )[0];
        return r
          ? {
              source_hash: r.source_hash as string,
              rows: Number(r.rows),
              created: Number(r.created),
              updated: Number(r.updated),
              unchanged: Number(r.unchanged),
              imported_by: r.imported_by as string,
              imported_at: r.imported_at as string,
            }
          : null;
      },
    },

    keyRegistry: {
      get: async (name: string): Promise<KeyRegistryRow | null> => {
        const r = (await all("SELECT * FROM key_registry WHERE name = ?", [name]))[0];
        return r ? toKey(r) : null;
      },
      list: async (): Promise<KeyRegistryRow[]> =>
        (await all("SELECT * FROM key_registry ORDER BY name")).map(toKey),
      failing: async (): Promise<KeyRegistryRow[]> =>
        (await all("SELECT * FROM key_registry WHERE status = 'failing' ORDER BY name")).map(toKey),
      /** Upserts status fields. Takes no value argument by design. */
      put: async (
        name: string,
        p: Partial<Omit<KeyRegistryRow, "name" | "updated_at">>,
      ): Promise<void> => {
        const cur = (await all("SELECT * FROM key_registry WHERE name = ?", [name]))[0];
        const base = cur
          ? toKey(cur)
          : {
              status: "unset" as KeyStatus,
              last_used_at: null,
              last_ok_at: null,
              last_error: null,
              used_by: [],
              updated_by: null,
            };
        const n = { ...base, ...p };
        await db.run(
          "INSERT INTO key_registry (name, status, last_used_at, last_ok_at, last_error, used_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET status = excluded.status, last_used_at = excluded.last_used_at, last_ok_at = excluded.last_ok_at, last_error = excluded.last_error, used_by = excluded.used_by, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
          [
            name,
            n.status,
            n.last_used_at,
            n.last_ok_at,
            n.last_error,
            JSON.stringify(n.used_by ?? []),
            nowIso(),
            n.updated_by,
          ],
        );
      },
    },

    digests: {
      put: async (day: string, body: unknown) => {
        await db.run(
          "INSERT INTO digests (day, body, created_at) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET body = excluded.body, created_at = excluded.created_at",
          [day, JSON.stringify(body), nowIso()],
        );
      },
      get: async (day: string) => {
        const r = (await all("SELECT * FROM digests WHERE day = ?", [day]))[0];
        return r
          ? { day: r.day as string, body: pj(r.body), created_at: r.created_at as string }
          : null;
      },
      latest: async () => {
        const r = (await all("SELECT * FROM digests ORDER BY day DESC LIMIT 1"))[0];
        return r
          ? { day: r.day as string, body: pj(r.body), created_at: r.created_at as string }
          : null;
      },
    },

    crm: {
      /**
       * Every company with any outreach activity (or a live opportunity), with what the CRM needs to
       * derive its stage. `includeSynthetic` adds simulator rows (labelled by the caller).
       */
      activity: async (o: { includeSynthetic: boolean }): Promise<CompanyActivity[]> => {
        const syn = o.includeSynthetic ? "" : " AND synthetic = 0";
        const map = new Map<string, CompanyActivity>();
        const get = (id: string) => {
          let a = map.get(id);
          if (!a) {
            a = {
              entity_id: id,
              name: null,
              events: {},
              letters: {},
              claim: null,
              opted_out: false,
              opportunity: null,
              open_tasks: [],
              synthetic: false,
            };
            map.set(id, a);
          }
          return a;
        };
        for (const r of await all(
          `SELECT entity_id, event, MAX(observed_at) AS at, MAX(synthetic) AS syn FROM outcomes
           WHERE dedupe_key IS NOT NULL${syn} GROUP BY entity_id, event`,
        )) {
          const a = get(r.entity_id as string);
          a.events[r.event as string] = r.at as string;
          if (Number(r.syn) === 1) a.synthetic = true;
        }
        for (const r of await all(
          `SELECT entity_id, status, COUNT(*) AS n FROM letters WHERE 1 = 1${syn} GROUP BY entity_id, status`,
        ))
          get(r.entity_id as string).letters[r.status as string] = Number(r.n);
        for (const r of await all(
          `SELECT entity_id, status, monthly_gbp, updated_at, synthetic FROM site_claims WHERE 1 = 1${syn} ORDER BY updated_at`,
        )) {
          const a = get(r.entity_id as string);
          a.claim = {
            status: r.status as string,
            monthly_gbp: Number(r.monthly_gbp),
            updated_at: r.updated_at as string,
          };
          if (Number(r.synthetic) === 1) a.synthetic = true;
        }
        for (const r of await all(
          `SELECT entity_id, expected_value_gbp, status, module FROM opportunities
           WHERE status IN ('proposed', 'approved', 'actioned') ORDER BY created_at`,
        ))
          get(r.entity_id as string).opportunity = {
            expected_value_gbp: Number(r.expected_value_gbp),
            status: r.status as string,
            module: r.module as string,
          };
        for (const r of await all(
          `SELECT task_id, playbook, status, updated_at, source_ref FROM tasks
           WHERE status IN ('queued', 'running', 'awaiting_approval')${syn} ORDER BY updated_at DESC`,
        )) {
          const id = (r.source_ref as string).match(/:entity:([A-Z0-9]{8})$/)?.[1];
          if (id)
            get(id).open_tasks.push({
              task_id: r.task_id as string,
              playbook: r.playbook as string,
              status: r.status as string,
              updated_at: r.updated_at as string,
            });
        }
        // Opted out: the company itself ("entity:<number>") or an address we wrote to.
        for (const r of await all(
          "SELECT substr(address, 8) AS id FROM suppressions WHERE address LIKE 'entity:%'",
        ))
          if (map.has((r.id as string).toUpperCase()))
            get((r.id as string).toUpperCase()).opted_out = true;
        for (const r of await all(
          `SELECT DISTINCT o.entity_id AS id FROM outbox o JOIN suppressions s ON s.address = lower(o.recipient)
           WHERE o.entity_id IS NOT NULL`,
        ))
          if (map.has(r.id as string)) get(r.id as string).opted_out = true;
        const ids = [...map.keys()];
        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          for (const r of await all(
            `SELECT entity_id, name FROM entities WHERE entity_id IN (${chunk.map(() => "?").join(",")})`,
            chunk,
          ))
            get(r.entity_id as string).name = r.name as string;
        }
        return [...map.values()];
      },
    },

    ledgerRange: async (o: {
      from: string;
      to: string;
      includeSynthetic: boolean;
      playbook?: string;
    }): Promise<LedgerRow[]> => {
      const where = ["dedupe_key IS NOT NULL", "observed_at >= ?", "observed_at < ?"];
      const args: SqlValue[] = [o.from, o.to];
      if (!o.includeSynthetic) where.push("synthetic = 0");
      if (o.playbook) {
        where.push("playbook = ?");
        args.push(o.playbook);
      }
      const rows = await all(
        `SELECT * FROM outcomes WHERE ${where.join(" AND ")} ORDER BY observed_at`,
        args,
      );
      return rows.map(toLedger);
    },

    ledgerForEntity: async (entityId: string): Promise<LedgerRow[]> => {
      const rows = await all(
        "SELECT * FROM outcomes WHERE dedupe_key IS NOT NULL AND entity_id = ? ORDER BY observed_at DESC LIMIT 500",
        [entityId],
      );
      return rows.map(toLedger);
    },
  };
}

const toHyp = (r: Row): HypothesisRow => ({
  id: r.id as string,
  rank: Number(r.rank),
  idea: r.idea as string,
  category: r.category as string,
  taxonomy_node: (r.taxonomy_node as string | null) ?? null,
  buyer: r.buyer as string,
  revenue_model: r.revenue_model as string,
  why_now: r.why_now as string,
  batch: r.batch as string,
  autonomy: Number(r.autonomy),
  speed_to_cash: Number(r.speed_to_cash),
  demand: Number(r.demand),
  margin: Number(r.margin),
  ease_of_build: Number(r.ease_of_build),
  low_risk: Number(r.low_risk),
  score: Number(r.score),
  matrix: r.matrix as IdeaMatrix,
  score_source: "estimate",
  file_status: r.file_status as "New" | "Built",
  stage: r.stage as string,
  stage_changed_by: (r.stage_changed_by as string | null) ?? null,
  decision: (r.decision as HypothesisRow["decision"]) ?? null,
  decision_by: (r.decision_by as string | null) ?? null,
  decision_at: (r.decision_at as string | null) ?? null,
  failed_fingerprint: (r.failed_fingerprint as string | null) ?? null,
  comments: (r.comments as string | null) ?? null,
  function: (r.function as string | null) ?? null,
  function_source: (r.function_source as HypothesisRow["function_source"]) ?? null,
  function_changed_by: (r.function_changed_by as string | null) ?? null,
  market_buyer: (r.market_buyer as string | null) ?? null,
  market_industry: (r.market_industry as string | null) ?? null,
  synthetic: Number(r.synthetic) === 1,
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});

const toKey = (r: Row): KeyRegistryRow => ({
  name: r.name as string,
  status: r.status as KeyStatus,
  last_used_at: (r.last_used_at as string | null) ?? null,
  last_ok_at: (r.last_ok_at as string | null) ?? null,
  last_error: (r.last_error as string | null) ?? null,
  used_by: r.used_by ? (JSON.parse(r.used_by as string) as string[]) : [],
  updated_at: r.updated_at as string,
  updated_by: (r.updated_by as string | null) ?? null,
});

export type V3Storage = ReturnType<typeof v3Storage>;
