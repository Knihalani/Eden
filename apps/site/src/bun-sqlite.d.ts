declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, opts?: { create?: boolean });
    exec(sql: string): void;
    run(sql: string, params?: unknown[]): void;
    query(sql: string): {
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
  }
}
