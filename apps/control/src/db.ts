import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type Query = {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

/** sqlite's run result; `changes` is what makes a conditional INSERT checkable. */
export type RunResult = { changes: number };

/** bun:sqlite-shaped handle so Store stays one code path on Bun and Node. */
export type EdenDb = {
  exec: (sql: string) => void;
  run: (sql: string, params?: unknown[]) => RunResult;
  query: (sql: string) => Query;
};

export function openDb(path: string): EdenDb {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const { Database } = require("bun:sqlite") as {
      Database: new (path: string) => {
        exec: (sql: string) => void;
        run: (sql: string, params?: unknown[]) => { changes?: number };
        query: (sql: string) => Query;
      };
    };
    const db = new Database(path);
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, params = []) => ({ changes: db.run(sql, params).changes ?? 0 }),
      query: (sql) => db.query(sql),
    };
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        get: (...params: unknown[]) => unknown;
        all: (...params: unknown[]) => unknown[];
        run: (...params: unknown[]) => { changes?: number };
      };
    };
  };
  const db = new DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => ({ changes: db.prepare(sql).run(...params).changes ?? 0 }),
    query: (sql) => {
      const stmt = db.prepare(sql);
      return {
        get: (...params) => stmt.get(...params) ?? null,
        all: (...params) => (stmt.all(...params) ?? []) as unknown[],
      };
    },
  };
}
