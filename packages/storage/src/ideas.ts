import type { SqlDriver, SqlValue } from "./driver.ts";

/**
 * v3 Phase 6 storage: signals, versioned idea cards, the card thread (append-only), the Board and
 * experiments. A card revision is a new (card_id, version) row; only its status changes in place.
 */
type Row = Record<string, unknown>;
const pj = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : null);
const nowIso = () => new Date().toISOString();
const bool = (v: unknown) => Number(v) === 1;

export interface SignalRow {
  signal_id: string;
  field: string;
  source_name: string;
  source_url: string;
  lane: "open" | "licensed";
  entity_id: string | null;
  signal_type: string;
  value: number | boolean | string;
  taxonomy_node: string;
  market_key: string;
  market: { buyer: string; industry: string | null };
  observed_at: string;
  synthetic: boolean;
}

export interface IdeaCardRow {
  card_id: string;
  version: number;
  hypothesis_id: string | null;
  market_key: string;
  card: unknown;
  status: string;
  status_reason: string | null;
  rank_value: number;
  synthetic: boolean;
  created_at: string;
  updated_at: string;
}

export interface ThreadRow {
  id: number;
  card_id: string;
  version: number;
  kind: "question" | "answer" | "comment" | "revision";
  author: string;
  text: string;
  evidence: string[];
  created_at: string;
}

export interface BoardTileRow {
  market_key: string;
  label: string;
  field: string;
  col: "scanning" | "researching" | "proposed" | "testing" | "live" | "killed";
  pinned: boolean;
  synthetic: boolean;
  updated_by: string;
  updated_at: string;
}

export interface BoardMoveRow {
  id: number;
  market_key: string;
  from_col: string | null;
  to_col: string;
  by: string;
  reason: string;
  at: string;
}

export interface ExperimentRow {
  id: string;
  card_id: string;
  version: number;
  hypothesis_id: string | null;
  market_key: string;
  status: "running" | "killed" | "succeeded" | "ended";
  budget_gbp: number;
  spent_gbp: number;
  instance_id: string | null;
  approval_id: string | null;
  kill_reason: string | null;
  postmortem_path: string | null;
  synthetic: boolean;
  started_at: string;
  ended_at: string | null;
}

const signal = (r: Row): SignalRow => ({
  signal_id: r.signal_id as string,
  field: r.field as string,
  source_name: r.source_name as string,
  source_url: r.source_url as string,
  lane: r.lane as SignalRow["lane"],
  entity_id: (r.entity_id as string | null) ?? null,
  signal_type: r.signal_type as string,
  value: pj(r.value) as SignalRow["value"],
  taxonomy_node: r.taxonomy_node as string,
  market_key: r.market_key as string,
  market: pj(r.market) as SignalRow["market"],
  observed_at: r.observed_at as string,
  synthetic: bool(r.synthetic),
});
const card = (r: Row): IdeaCardRow => ({
  card_id: r.card_id as string,
  version: Number(r.version),
  hypothesis_id: (r.hypothesis_id as string | null) ?? null,
  market_key: r.market_key as string,
  card: pj(r.card),
  status: r.status as string,
  status_reason: (r.status_reason as string | null) ?? null,
  rank_value: Number(r.rank_value),
  synthetic: bool(r.synthetic),
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});
const thread = (r: Row): ThreadRow => ({
  id: Number(r.id),
  card_id: r.card_id as string,
  version: Number(r.version),
  kind: r.kind as ThreadRow["kind"],
  author: r.author as string,
  text: r.text as string,
  evidence: (pj(r.evidence) as string[]) ?? [],
  created_at: r.created_at as string,
});
const tile = (r: Row): BoardTileRow => ({
  market_key: r.market_key as string,
  label: r.label as string,
  field: r.field as string,
  col: r.col as BoardTileRow["col"],
  pinned: bool(r.pinned),
  synthetic: bool(r.synthetic),
  updated_by: r.updated_by as string,
  updated_at: r.updated_at as string,
});
const experiment = (r: Row): ExperimentRow => ({
  id: r.id as string,
  card_id: r.card_id as string,
  version: Number(r.version),
  hypothesis_id: (r.hypothesis_id as string | null) ?? null,
  market_key: r.market_key as string,
  status: r.status as ExperimentRow["status"],
  budget_gbp: Number(r.budget_gbp),
  spent_gbp: Number(r.spent_gbp),
  instance_id: (r.instance_id as string | null) ?? null,
  approval_id: (r.approval_id as string | null) ?? null,
  kill_reason: (r.kill_reason as string | null) ?? null,
  postmortem_path: (r.postmortem_path as string | null) ?? null,
  synthetic: bool(r.synthetic),
  started_at: r.started_at as string,
  ended_at: (r.ended_at as string | null) ?? null,
});

export function ideasStorage(db: SqlDriver) {
  const insert = async (table: string, row: Record<string, SqlValue>) => {
    const cols = Object.keys(row);
    await db.run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((c) => row[c] ?? null),
    );
  };
  return {
    scoutSignals: {
      /** Idempotent on signal_id. */
      add: async (s: Omit<SignalRow, "synthetic"> & { synthetic?: boolean }): Promise<boolean> => {
        const r = await db.run(
          `INSERT OR IGNORE INTO scout_signals (signal_id, field, source_name, source_url, lane, entity_id, signal_type, value, taxonomy_node, market_key, market, observed_at, untrusted, synthetic, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            s.signal_id,
            s.field,
            s.source_name,
            s.source_url,
            s.lane,
            s.entity_id,
            s.signal_type,
            JSON.stringify(s.value),
            s.taxonomy_node,
            s.market_key,
            JSON.stringify(s.market),
            s.observed_at,
            s.synthetic ? 1 : 0,
            nowIso(),
          ],
        );
        return r.changes > 0;
      },
      get: async (id: string): Promise<SignalRow | null> => {
        const [r] = await db.all("SELECT * FROM scout_signals WHERE signal_id = ?", [id]);
        return r ? signal(r) : null;
      },
      forMarket: async (marketKey: string, limit = 200): Promise<SignalRow[]> =>
        (
          await db.all(
            "SELECT * FROM scout_signals WHERE market_key = ? ORDER BY observed_at DESC LIMIT ?",
            [marketKey, limit],
          )
        ).map(signal),
      list: async (limit = 500): Promise<SignalRow[]> =>
        (
          await db.all("SELECT * FROM scout_signals ORDER BY observed_at DESC LIMIT ?", [limit])
        ).map(signal),
    },

    ideaCards: {
      add: async (
        c: Omit<IdeaCardRow, "created_at" | "updated_at" | "status_reason"> & {
          status_reason?: string | null;
        },
      ): Promise<void> => {
        const at = nowIso();
        await insert("idea_cards", {
          card_id: c.card_id,
          version: c.version,
          hypothesis_id: c.hypothesis_id,
          market_key: c.market_key,
          card: JSON.stringify(c.card),
          status: c.status,
          status_reason: c.status_reason ?? null,
          rank_value: c.rank_value,
          synthetic: c.synthetic ? 1 : 0,
          created_at: at,
          updated_at: at,
        });
      },
      get: async (cardId: string, version: number): Promise<IdeaCardRow | null> => {
        const [r] = await db.all("SELECT * FROM idea_cards WHERE card_id = ? AND version = ?", [
          cardId,
          version,
        ]);
        return r ? card(r) : null;
      },
      latest: async (cardId: string): Promise<IdeaCardRow | null> => {
        const [r] = await db.all(
          "SELECT * FROM idea_cards WHERE card_id = ? ORDER BY version DESC LIMIT 1",
          [cardId],
        );
        return r ? card(r) : null;
      },
      versions: async (cardId: string): Promise<IdeaCardRow[]> =>
        (await db.all("SELECT * FROM idea_cards WHERE card_id = ? ORDER BY version", [cardId])).map(
          card,
        ),
      /** The latest version of every card, best ranked first. */
      list: async (o: { status?: string[]; limit?: number } = {}): Promise<IdeaCardRow[]> => {
        const rows = (
          await db.all(
            `SELECT c.* FROM idea_cards c
             JOIN (SELECT card_id, MAX(version) AS v FROM idea_cards GROUP BY card_id) m
               ON m.card_id = c.card_id AND m.v = c.version
             ORDER BY c.rank_value DESC, c.card_id LIMIT ?`,
            [o.limit ?? 500],
          )
        ).map(card);
        return o.status ? rows.filter((r) => o.status?.includes(r.status)) : rows;
      },
      forHypothesis: async (hypothesisId: string): Promise<IdeaCardRow[]> =>
        (
          await db.all("SELECT * FROM idea_cards WHERE hypothesis_id = ? ORDER BY created_at", [
            hypothesisId,
          ])
        ).map(card),
      forMarket: async (marketKey: string): Promise<IdeaCardRow[]> =>
        (
          await db.all("SELECT * FROM idea_cards WHERE market_key = ? ORDER BY card_id, version", [
            marketKey,
          ])
        ).map(card),
      setStatus: async (
        cardId: string,
        version: number,
        status: string,
        reason: string | null = null,
      ): Promise<void> => {
        await db.run(
          "UPDATE idea_cards SET status = ?, status_reason = ?, updated_at = ? WHERE card_id = ? AND version = ?",
          [status, reason, nowIso(), cardId, version],
        );
      },
    },

    ideaThread: {
      add: async (t: Omit<ThreadRow, "id" | "created_at">): Promise<void> =>
        insert("idea_thread", {
          card_id: t.card_id,
          version: t.version,
          kind: t.kind,
          author: t.author,
          text: t.text,
          evidence: JSON.stringify(t.evidence),
          created_at: nowIso(),
        }),
      forCard: async (cardId: string): Promise<ThreadRow[]> =>
        (await db.all("SELECT * FROM idea_thread WHERE card_id = ? ORDER BY id", [cardId])).map(
          thread,
        ),
    },

    board: {
      get: async (marketKey: string): Promise<BoardTileRow | null> => {
        const [r] = await db.all("SELECT * FROM board_tiles WHERE market_key = ?", [marketKey]);
        return r ? tile(r) : null;
      },
      list: async (): Promise<BoardTileRow[]> =>
        (await db.all("SELECT * FROM board_tiles ORDER BY pinned DESC, updated_at DESC")).map(tile),
      /** Creates the tile if it's new (in `col`), otherwise leaves it alone. */
      ensure: async (t: {
        market_key: string;
        label: string;
        field: string;
        col: BoardTileRow["col"];
        by: string;
        synthetic?: boolean;
      }): Promise<boolean> => {
        const at = nowIso();
        const r = await db.run(
          "INSERT OR IGNORE INTO board_tiles (market_key, label, field, col, pinned, synthetic, updated_by, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
          [t.market_key, t.label, t.field, t.col, t.synthetic ? 1 : 0, t.by, at],
        );
        if (r.changes > 0)
          await insert("board_moves", {
            market_key: t.market_key,
            from_col: null,
            to_col: t.col,
            by: t.by,
            reason: "first signal",
            at,
          });
        return r.changes > 0;
      },
      move: async (
        marketKey: string,
        to: BoardTileRow["col"],
        by: string,
        reason: string,
      ): Promise<boolean> => {
        const [r] = await db.all("SELECT col FROM board_tiles WHERE market_key = ?", [marketKey]);
        if (!r || r.col === to) return false;
        const at = nowIso();
        await db.batch([
          {
            sql: "UPDATE board_tiles SET col = ?, updated_by = ?, updated_at = ? WHERE market_key = ?",
            params: [to, by, at, marketKey],
          },
          {
            sql: "INSERT INTO board_moves (market_key, from_col, to_col, by, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
            params: [marketKey, r.col as string, to, by, reason, at],
          },
        ]);
        return true;
      },
      setPinned: async (marketKey: string, pinned: boolean, by: string): Promise<void> => {
        await db.run(
          "UPDATE board_tiles SET pinned = ?, updated_by = ?, updated_at = ? WHERE market_key = ?",
          [pinned ? 1 : 0, by, nowIso(), marketKey],
        );
      },
      moves: async (marketKey: string): Promise<BoardMoveRow[]> =>
        (
          await db.all("SELECT * FROM board_moves WHERE market_key = ? ORDER BY id", [marketKey])
        ).map((r) => ({
          id: Number(r.id),
          market_key: r.market_key as string,
          from_col: (r.from_col as string | null) ?? null,
          to_col: r.to_col as string,
          by: r.by as string,
          reason: r.reason as string,
          at: r.at as string,
        })),
    },

    experiments: {
      add: async (
        e: Omit<ExperimentRow, "spent_gbp" | "kill_reason" | "postmortem_path" | "ended_at">,
      ): Promise<void> =>
        insert("experiments", {
          ...e,
          synthetic: e.synthetic ? 1 : 0,
        } as Record<string, SqlValue>),
      get: async (id: string): Promise<ExperimentRow | null> => {
        const [r] = await db.all("SELECT * FROM experiments WHERE id = ?", [id]);
        return r ? experiment(r) : null;
      },
      forCard: async (cardId: string): Promise<ExperimentRow[]> =>
        (
          await db.all("SELECT * FROM experiments WHERE card_id = ? ORDER BY started_at", [cardId])
        ).map(experiment),
      forMarket: async (marketKey: string): Promise<ExperimentRow[]> =>
        (
          await db.all("SELECT * FROM experiments WHERE market_key = ? ORDER BY started_at", [
            marketKey,
          ])
        ).map(experiment),
      running: async (): Promise<ExperimentRow[]> =>
        (await db.all("SELECT * FROM experiments WHERE status = 'running'")).map(experiment),
      update: async (
        id: string,
        p: Partial<
          Pick<
            ExperimentRow,
            "status" | "spent_gbp" | "instance_id" | "kill_reason" | "postmortem_path" | "ended_at"
          >
        >,
      ): Promise<void> => {
        const cols = Object.keys(p);
        if (!cols.length) return;
        await db.run(
          `UPDATE experiments SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
          [...cols.map((c) => (p as Record<string, SqlValue>)[c] ?? null), id],
        );
      },
    },
  };
}
export type IdeasStorage = ReturnType<typeof ideasStorage>;
