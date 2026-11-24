import type { SqlDriver } from "./driver.ts";

/** Archie's ranked idea matrix (four scores of its own). See migration 0024. */
export interface IdeaMatrixRow {
  id: string;
  list_no: number;
  rank: number;
  idea: string;
  build_angle: string;
  fit: number;
  speed_to_cash: number;
  demand: number;
  solo_build: number;
  score: number;
  score_source: "estimate";
  decision: "Pass" | "Fail" | "Question" | null;
  decision_by: string | null;
  decision_at: string | null;
  comments: string | null;
  source: string;
  synthetic: boolean;
  created_at: string;
  updated_at: string;
}

const row = (r: Record<string, unknown>): IdeaMatrixRow => ({
  id: r.id as string,
  list_no: Number(r.list_no),
  rank: Number(r.rank),
  idea: r.idea as string,
  build_angle: r.build_angle as string,
  fit: Number(r.fit),
  speed_to_cash: Number(r.speed_to_cash),
  demand: Number(r.demand),
  solo_build: Number(r.solo_build),
  score: Number(r.score),
  score_source: "estimate",
  decision: (r.decision as IdeaMatrixRow["decision"]) ?? null,
  decision_by: (r.decision_by as string | null) ?? null,
  decision_at: (r.decision_at as string | null) ?? null,
  comments: (r.comments as string | null) ?? null,
  source: r.source as string,
  synthetic: Number(r.synthetic) === 1,
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});

export function ideaMatrixStorage(db: SqlDriver) {
  return {
    ideaMatrix: {
      get: async (id: string): Promise<IdeaMatrixRow | null> => {
        const [r] = await db.all("SELECT * FROM idea_matrix WHERE id = ?", [id]);
        return r ? row(r) : null;
      },
      list: async (): Promise<IdeaMatrixRow[]> =>
        (await db.all("SELECT * FROM idea_matrix ORDER BY rank, list_no")).map(row),
      count: async (): Promise<number> =>
        Number((await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM idea_matrix"))[0]?.n ?? 0),
      /** Insert or update the sheet's fields. Archie's decision and comments are never overwritten. */
      put: async (
        r: Omit<
          IdeaMatrixRow,
          | "decision"
          | "decision_by"
          | "decision_at"
          | "comments"
          | "created_at"
          | "updated_at"
          | "score_source"
        >,
      ): Promise<void> => {
        const at = new Date().toISOString();
        await db.run(
          `INSERT INTO idea_matrix (id, list_no, rank, idea, build_angle, fit, speed_to_cash, demand, solo_build, score, score_source, source, synthetic, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estimate', ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET list_no = excluded.list_no, rank = excluded.rank, idea = excluded.idea,
             build_angle = excluded.build_angle, fit = excluded.fit, speed_to_cash = excluded.speed_to_cash,
             demand = excluded.demand, solo_build = excluded.solo_build, score = excluded.score,
             source = excluded.source, updated_at = excluded.updated_at`,
          [
            r.id,
            r.list_no,
            r.rank,
            r.idea,
            r.build_angle,
            r.fit,
            r.speed_to_cash,
            r.demand,
            r.solo_build,
            r.score,
            r.source,
            r.synthetic ? 1 : 0,
            at,
            at,
          ],
        );
      },
    },
  };
}
export type IdeaMatrixStorage = ReturnType<typeof ideaMatrixStorage>;
