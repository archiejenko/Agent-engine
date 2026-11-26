import type { BlobStore } from "./blobs.ts";
import type { SqlDriver, SqlValue } from "./driver.ts";
import type { GraphNodeRunRow } from "./graph.ts";

/**
 * Per-run graph state (data layer plan, step 1): each node's run row (with the recorded model output a
 * replay reuses) and the run's state values. This is the hot, short-lived part of a graph run, so it
 * doesn't live in D1:
 * - on Cloudflare: one `RunState` Durable Object per run (`idFromName(run_id)`), which runs THIS code
 *   on its own SQLite storage and is emptied with `deleteAll()` when the run closes;
 * - locally: the same code on a SQLite file (`data/runs.sqlite`), or on the test database.
 *
 * When a run ends, `close` writes one archive object per run (`runs/<run_id>/archive.json`) to the
 * blob store and deletes the rows, so any run can still be replayed and audited (rule 8). Reading a
 * closed run's node runs comes from that archive.
 */
export interface StateValueRow {
  run_id: string;
  key: string;
  iteration: number;
  value: unknown;
  untrusted: boolean;
  lane: "open" | "licensed";
  written_by: string;
}

export interface NodeFinish {
  status: GraphNodeRunRow["status"];
  cost_gbp?: number;
  output_ref?: string | null;
  recorded_model_output?: unknown;
  check_results?: unknown;
  error?: string | null;
}

export interface RunArchive {
  run_id: string;
  closed_at: string;
  node_runs: GraphNodeRunRow[];
  state_values: (StateValueRow & { created_at: string })[];
}

export interface RunCloseResult {
  archive_key: string;
  node_runs: number;
  state_values: number;
}

export interface RunStore {
  /** Idempotent on (run, node, iteration): a re-delivered job finds the existing row. */
  start(runId: string, nodeId: string, iteration: number): Promise<GraphNodeRunRow>;
  get(runId: string, nodeId: string, iteration: number): Promise<GraphNodeRunRow | null>;
  finish(runId: string, nodeId: string, iteration: number, p: NodeFinish): Promise<void>;
  /** Live rows while the run is open; the archive once it's closed. */
  nodeRuns(runId: string): Promise<GraphNodeRunRow[]>;
  put(v: StateValueRow): Promise<void>;
  /** The latest iteration of each key. */
  latest(runId: string): Promise<Omit<StateValueRow, "run_id">[]>;
  /** Archive the run to the blob store, then delete its rows. Safe to call twice. */
  close(runId: string): Promise<RunCloseResult>;
}

export const runArchiveKey = (runId: string) => `runs/${runId}/archive.json`;

/** Applied by the Durable Object in its constructor and by the local store on first use. */
export const RUN_STORE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS run_node_runs (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'done', 'failed', 'skipped', 'paused')),
  started_at TEXT,
  ended_at TEXT,
  cost_gbp REAL NOT NULL DEFAULT 0,
  output_ref TEXT,
  recorded_model_output TEXT,
  check_results TEXT,
  error TEXT,
  PRIMARY KEY (run_id, node_id, iteration)
) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS run_state_values (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  value TEXT NOT NULL,
  untrusted INTEGER NOT NULL DEFAULT 0,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  written_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, key, iteration)
) WITHOUT ROWID`,
];

type Row = Record<string, unknown>;
const pj = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(v as string));
const json = (v: unknown): SqlValue => (v === undefined ? null : JSON.stringify(v));

const toNodeRun = (r: Row): GraphNodeRunRow => ({
  run_id: r.run_id as string,
  node_id: r.node_id as string,
  iteration: Number(r.iteration),
  status: r.status as GraphNodeRunRow["status"],
  started_at: (r.started_at as string | null) ?? null,
  ended_at: (r.ended_at as string | null) ?? null,
  cost_gbp: Number(r.cost_gbp),
  output_ref: (r.output_ref as string | null) ?? null,
  recorded_model_output: pj(r.recorded_model_output),
  check_results: pj(r.check_results),
  error: (r.error as string | null) ?? null,
});

const toState = (r: Row) => ({
  run_id: r.run_id as string,
  key: r.key as string,
  iteration: Number(r.iteration),
  value: pj(r.value),
  untrusted: r.untrusted === 1 || r.untrusted === true,
  lane: r.lane as "open" | "licensed",
  written_by: r.written_by as string,
  created_at: r.created_at as string,
});

async function readArchive(blobs: BlobStore, runId: string): Promise<RunArchive | null> {
  const b = await blobs.get(runArchiveKey(runId));
  return b ? (JSON.parse(new TextDecoder().decode(b)) as RunArchive) : null;
}

/** The run store over any SQL driver (a SQLite file, the test database, or a Durable Object's SQL). */
export function sqlRunStore(
  db: SqlDriver,
  blobs: BlobStore,
  o: { now?: () => Date } = {},
): RunStore {
  const nowIso = () => (o.now?.() ?? new Date()).toISOString();
  let ready: Promise<void> | null = null;
  const ensure = () => {
    ready ??= db.batch(RUN_STORE_SCHEMA.map((sql) => ({ sql })));
    return ready;
  };
  const one = async (runId: string, nodeId: string, iteration: number) => {
    await ensure();
    const r = (
      await db.all(
        "SELECT * FROM run_node_runs WHERE run_id = ? AND node_id = ? AND iteration = ?",
        [runId, nodeId, iteration],
      )
    )[0];
    return r ? toNodeRun(r) : null;
  };
  const live = async (runId: string) => {
    await ensure();
    return (
      await db.all(
        "SELECT * FROM run_node_runs WHERE run_id = ? ORDER BY started_at, node_id, iteration",
        [runId],
      )
    ).map(toNodeRun);
  };
  return {
    async start(runId, nodeId, iteration) {
      await ensure();
      await db.run(
        "INSERT INTO run_node_runs (run_id, node_id, iteration, status, started_at) VALUES (?, ?, ?, 'running', ?) ON CONFLICT (run_id, node_id, iteration) DO NOTHING",
        [runId, nodeId, iteration, nowIso()],
      );
      return (await one(runId, nodeId, iteration)) as GraphNodeRunRow;
    },
    get: one,
    async finish(runId, nodeId, iteration, p) {
      await ensure();
      await db.run(
        "UPDATE run_node_runs SET status = ?, ended_at = ?, cost_gbp = cost_gbp + ?, output_ref = COALESCE(?, output_ref), recorded_model_output = COALESCE(?, recorded_model_output), check_results = COALESCE(?, check_results), error = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
        [
          p.status,
          nowIso(),
          p.cost_gbp ?? 0,
          p.output_ref ?? null,
          json(p.recorded_model_output),
          json(p.check_results),
          p.error ?? null,
          runId,
          nodeId,
          iteration,
        ],
      );
    },
    async nodeRuns(runId) {
      const rows = await live(runId);
      if (rows.length) return rows;
      return (await readArchive(blobs, runId))?.node_runs ?? [];
    },
    async put(v) {
      await ensure();
      await db.run(
        "INSERT INTO run_state_values (run_id, key, iteration, value, untrusted, lane, written_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id, key, iteration) DO UPDATE SET value = excluded.value, untrusted = excluded.untrusted, lane = excluded.lane, written_by = excluded.written_by",
        [
          v.run_id,
          v.key,
          v.iteration,
          JSON.stringify(v.value),
          v.untrusted ? 1 : 0,
          v.lane,
          v.written_by,
          nowIso(),
        ],
      );
    },
    async latest(runId) {
      await ensure();
      return (
        await db.all(
          "SELECT s.* FROM run_state_values s JOIN (SELECT key, MAX(iteration) AS it FROM run_state_values WHERE run_id = ? GROUP BY key) m ON s.key = m.key AND s.iteration = m.it WHERE s.run_id = ?",
          [runId, runId],
        )
      ).map((r) => {
        const { run_id: _r, created_at: _c, ...v } = toState(r);
        return v;
      });
    },
    async close(runId) {
      const node_runs = await live(runId);
      const state = (
        await db.all("SELECT * FROM run_state_values WHERE run_id = ? ORDER BY key, iteration", [
          runId,
        ])
      ).map(toState);
      const key = runArchiveKey(runId);
      if (!node_runs.length && !state.length) {
        // Already closed (or never used): leave any existing archive as it is.
        const a = await readArchive(blobs, runId);
        return {
          archive_key: key,
          node_runs: a?.node_runs.length ?? 0,
          state_values: a?.state_values.length ?? 0,
        };
      }
      const archive: RunArchive = {
        run_id: runId,
        closed_at: nowIso(),
        node_runs,
        state_values: state,
      };
      // Archive first, delete second: a crash in between leaves both, never neither.
      await blobs.put(key, JSON.stringify(archive), { contentType: "application/json" });
      await db.batch([
        { sql: "DELETE FROM run_node_runs WHERE run_id = ?", params: [runId] },
        { sql: "DELETE FROM run_state_values WHERE run_id = ?", params: [runId] },
      ]);
      return { archive_key: key, node_runs: node_runs.length, state_values: state.length };
    },
  };
}

/** The archive of a closed run, or null. */
export const runArchive = readArchive;
