/** Values we pass to SQL. JSON is serialised to TEXT before it gets here. */
export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

/**
 * The tiny surface both databases share. Only packages/storage implements or calls this.
 */
export interface SqlDriver {
  readonly dialect: "sqlite" | "d1";
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Runs all statements atomically: all succeed or none do. */
  batch(statements: SqlStatement[]): Promise<void>;
  close(): Promise<void>;
}
