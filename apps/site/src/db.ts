import { createHash } from "node:crypto";

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, name TEXT)`,
  `CREATE TABLE IF NOT EXISTS api_key (prefix TEXT PRIMARY KEY, hash TEXT, workspace_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS tool_event (
      event_id TEXT PRIMARY KEY, workspace_id TEXT, run_id TEXT, seq INTEGER, name TEXT, args TEXT, command TEXT, ok INTEGER
    )`,
  `CREATE TABLE IF NOT EXISTS stretch (
      id TEXT PRIMARY KEY, workspace_id TEXT, run_id TEXT, fingerprint TEXT, steps TEXT, island_index INTEGER
    )`,
  `CREATE TABLE IF NOT EXISTS cluster (
      fingerprint TEXT PRIMARY KEY, workspace_id TEXT, count INTEGER, steps TEXT, status TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS tool (
      id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, when_to_use TEXT, state TEXT, steps TEXT, seen TEXT, fingerprint TEXT, uses_count INTEGER DEFAULT 0, cheap_check TEXT, required_k INTEGER DEFAULT 2, published INTEGER DEFAULT 0
    )`,
  `CREATE TABLE IF NOT EXISTS knock (
      id TEXT PRIMARY KEY, workspace_id TEXT, tool_id TEXT, attempt INTEGER, resolution TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS tool_run (
      id TEXT PRIMARY KEY, tool_id TEXT, steps_attempted INTEGER, steps_ok INTEGER, server_ms INTEGER, runner_ms INTEGER, raw_bytes INTEGER, densified_bytes INTEGER, billable_ms INTEGER, cache_hits INTEGER, receipt TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS result_cache (cache_key TEXT PRIMARY KEY, body TEXT, expires_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS ignore_fp (workspace_id TEXT, fingerprint TEXT, PRIMARY KEY (workspace_id, fingerprint))`,
  `CREATE TABLE IF NOT EXISTS wrap_cache (run_id TEXT, tool_id TEXT, facts TEXT, created_at BIGINT, PRIMARY KEY (run_id, tool_id))`,
  `CREATE TABLE IF NOT EXISTS watched_issue (workspace_id TEXT, issue TEXT, seen_at BIGINT, PRIMARY KEY (workspace_id, issue))`,
];

export class EdenDb {
  constructor(
    private sqlite: { run: Function; query: Function; exec: Function } | null,
    private neonSql: ((q: string, p: unknown[]) => Promise<unknown>) | null,
  ) {}

  async exec(sql: string): Promise<void> {
    if (this.sqlite) this.sqlite.exec(sql);
    else await this.neonSql!(sql, []);
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    if (this.sqlite) {
      this.sqlite.run(sql, params);
      return;
    }
    await this.neonSql!(toPg(sql), params);
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    // bun:sqlite yields `null` for "no row" while Neon yields `undefined`.
    // Normalising here keeps the declared return type honest, so a caller
    // testing `=== undefined` cannot silently miss the SQLite case.
    if (this.sqlite) return (this.sqlite.query(sql).get(...params) as T | null) ?? undefined;
    const rows = (await this.neonSql!(toPg(sql), params)) as T[];
    return rows?.[0];
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.sqlite) return this.sqlite.query(sql).all(...params) as T[];
    return ((await this.neonSql!(toPg(sql), params)) as T[]) || [];
  }
}

function toPg(sql: string): string {
  let s = sql;
  if (/INSERT OR REPLACE INTO result_cache/i.test(s)) {
    s = s.replace(/INSERT OR REPLACE INTO/i, "INSERT INTO");
    s += " ON CONFLICT (cache_key) DO UPDATE SET body = EXCLUDED.body, expires_at = EXCLUDED.expires_at";
  }
  if (/INSERT OR REPLACE INTO watched_issue/i.test(s)) {
    s = s.replace(/INSERT OR REPLACE INTO/i, "INSERT INTO");
    s += " ON CONFLICT (workspace_id, issue) DO UPDATE SET seen_at = EXCLUDED.seen_at";
  }
  if (/INSERT OR IGNORE INTO/i.test(s)) {
    s = s.replace(/INSERT OR IGNORE INTO/i, "INSERT INTO") + " ON CONFLICT DO NOTHING";
  }
  let i = 0;
  s = s.replace(/\?/g, () => `$${++i}`);
  s = s.replace(/\bexcluded\./g, "EXCLUDED.");
  return s;
}

export async function openDb(path?: string): Promise<EdenDb> {
  const url = process.env.DATABASE_URL;
  if (url && !path) {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url);
    const db = new EdenDb(null, async (q, p) => sql.query(q, p as never[]));
    for (const stmt of SQLITE_STATEMENTS) await db.exec(stmt);
    await migrate(db, true);
    await seed(db);
    await hashLegacyKeys(db);
    return db;
  }
  if (process.env.VERCEL && !path) {
    throw new Error("DATABASE_URL is required on Vercel");
  }
  const file = path || process.env.EDEN_DB || "./.eden-local/eden.db";
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { Database } = await import("bun:sqlite");
  mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file, { create: true });
  sqlite.exec("PRAGMA journal_mode=WAL;");
  for (const stmt of SQLITE_STATEMENTS) sqlite.exec(stmt);
  const db = new EdenDb(sqlite, null);
  await migrate(db, false);
  await seed(db);
  await hashLegacyKeys(db);
  return db;
}

async function migrate(db: EdenDb, neon: boolean) {
  if (neon) {
    await db.exec(`ALTER TABLE result_cache ALTER COLUMN expires_at TYPE BIGINT`).catch(() => undefined);
    await db.exec(`ALTER TABLE wrap_cache ALTER COLUMN created_at TYPE BIGINT`).catch(() => undefined);
  }
  await db.exec(`ALTER TABLE tool ADD COLUMN required_k INTEGER DEFAULT 2`).catch(() => undefined);
  await db.exec(`ALTER TABLE tool ADD COLUMN published INTEGER DEFAULT 0`).catch(() => undefined);
}

/** The `hash` column stores this, never the token itself. */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The local development credential. Seeded only into an on-disk SQLite file —
 * never into a managed database. It used to be seeded unconditionally, which
 * put a publicly-known credential into every Neon-backed deployment: seed()
 * runs on the Neon branch of openDb(), and workspaceForKey() consults the table
 * before any environment check, so `Authorization: Bearer eden_dev` authorised
 * ingest, tool approval and /v1/play against production.
 */
const DEV_TOKEN = "eden_dev";

/**
 * Whether this process is serving a real deployment rather than a laptop.
 *
 * Deliberately keyed off the environment, not off which driver openDb() picked:
 * seeding and authentication must agree. If workspaceForKey() considers the
 * deployment managed — and so withholds the permissive dev fallback — then
 * seed() must not plant a dev credential behind its back.
 */
function isManagedDeployment(): boolean {
  return Boolean(process.env.DATABASE_URL) || Boolean(process.env.VERCEL);
}

async function seed(db: EdenDb) {
  await db.run(`INSERT OR IGNORE INTO workspace (id, name) VALUES (?, ?)`, ["ws_local", "local"]);
  if (isManagedDeployment()) return;
  await db.run(`INSERT OR IGNORE INTO api_key (prefix, hash, workspace_id) VALUES (?, ?, ?)`, [
    DEV_TOKEN,
    hashApiKey(DEV_TOKEN),
    "ws_local",
  ]);
}

/**
 * Rewrites any api_key row still holding a plaintext secret in `hash`.
 * Rows written before hashing existed would otherwise stop authenticating.
 */
async function hashLegacyKeys(db: EdenDb) {
  const rows = await db.all<{ prefix: string; hash: string | null }>(`SELECT prefix, hash FROM api_key`);
  for (const row of rows) {
    if (row.hash && /^[0-9a-f]{64}$/.test(row.hash)) continue;
    const secret = row.hash || row.prefix;
    await db.run(`UPDATE api_key SET hash = ? WHERE prefix = ?`, [hashApiKey(secret), row.prefix]);
  }
}

export async function workspaceForKey(db: EdenDb, auth: string | null): Promise<string | null> {
  const token = auth?.replace(/^Bearer\s+/i, "") || "";
  const devFallback = isManagedDeployment() ? process.env.EDEN_DEV === "1" : process.env.EDEN_DEV !== "0";
  if (!token) return devFallback ? "ws_local" : null;
  // Authenticate on the secret alone. `prefix` is a non-secret row identifier —
  // matching on it let anyone who had merely seen a key's label present that
  // label as the key.
  const row = await db.get<{ workspace_id: string }>(`SELECT workspace_id FROM api_key WHERE hash = ?`, [
    hashApiKey(token),
  ]);
  if (row?.workspace_id) return row.workspace_id;
  return devFallback && token.startsWith("eden_") ? "ws_local" : null;
}
