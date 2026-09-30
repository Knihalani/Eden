import { createHash } from "node:crypto";

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, name TEXT)`,
  `CREATE TABLE IF NOT EXISTS api_key (prefix TEXT PRIMARY KEY, hash TEXT, workspace_id TEXT)`,
  // Keyed by (workspace_id, event_id), not event_id alone. The id is chosen by
  // the client — `bench-horizon-product.ts` emits `bash-${seq}`, and any SDK
  // may do the same — so with a global key one tenant claiming an id silently
  // suppressed another tenant's event, because ingest inserts OR IGNORE. The
  // same reasoning as `cluster` below.
  `CREATE TABLE IF NOT EXISTS tool_event (
      event_id TEXT, workspace_id TEXT, run_id TEXT, seq INTEGER, name TEXT, args TEXT, command TEXT, ok INTEGER,
      PRIMARY KEY (workspace_id, event_id)
    )`,
  `CREATE TABLE IF NOT EXISTS stretch (
      id TEXT PRIMARY KEY, workspace_id TEXT, run_id TEXT, fingerprint TEXT, steps TEXT, island_index INTEGER
    )`,  // Keyed by (workspace_id, fingerprint), not fingerprint alone. Fingerprints
  // are derived from URL *shape*, so two tenants calling the same public API
  // produce the same one by construction — and with a global key the second
  // tenant's upsert landed in the first's row, resetting its count so it never
  // reached the knock threshold and feeding its recorded steps into the other
  // tenant's compiled tool.
  `CREATE TABLE IF NOT EXISTS cluster (
      fingerprint TEXT, workspace_id TEXT, count INTEGER, steps TEXT, status TEXT,
      PRIMARY KEY (workspace_id, fingerprint)
    )`,
  `CREATE TABLE IF NOT EXISTS tool (
      id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, when_to_use TEXT, state TEXT, steps TEXT, seen TEXT, fingerprint TEXT, uses_count INTEGER DEFAULT 0, cheap_check TEXT, required_k INTEGER DEFAULT 2, published INTEGER DEFAULT 0
    )`,
  `CREATE TABLE IF NOT EXISTS knock (
      id TEXT PRIMARY KEY, workspace_id TEXT, tool_id TEXT, attempt INTEGER, resolution TEXT
    )`,  `CREATE TABLE IF NOT EXISTS tool_run (
      id TEXT PRIMARY KEY, tool_id TEXT, steps_attempted INTEGER, steps_ok INTEGER, server_ms INTEGER, runner_ms INTEGER, raw_bytes INTEGER, densified_bytes INTEGER, billable_ms INTEGER, cache_hits INTEGER, receipt TEXT, created_at BIGINT DEFAULT 0
    )`,
  `CREATE TABLE IF NOT EXISTS result_cache (cache_key TEXT PRIMARY KEY, body TEXT, expires_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS ignore_fp (workspace_id TEXT, fingerprint TEXT, PRIMARY KEY (workspace_id, fingerprint))`,
  `CREATE TABLE IF NOT EXISTS wrap_cache (run_id TEXT, tool_id TEXT, facts TEXT, created_at BIGINT, PRIMARY KEY (run_id, tool_id))`,
  `CREATE TABLE IF NOT EXISTS watched_issue (workspace_id TEXT, issue TEXT, seen_at BIGINT, PRIMARY KEY (workspace_id, issue))`,
  `CREATE INDEX IF NOT EXISTS idx_tool_run_tool_created ON tool_run (tool_id, created_at)`,
  // Hot-path lookups. Every tool query filters (workspace_id, state); mining
  // reads a run's events back ordered by seq; the knock scan runs on every
  // /v1/live-tools poll. On Neon these were full scans per request.
  `CREATE INDEX IF NOT EXISTS idx_tool_ws_state ON tool (workspace_id, state)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_event_run ON tool_event (workspace_id, run_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_knock_ws ON knock (workspace_id, resolution)`,
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
    // Same per-statement tolerance as the SQLite path: migrate() backfills.
    for (const stmt of SQLITE_STATEMENTS) {
      try {
        await db.exec(stmt);
      } catch {
        /* migrate() backfills */
      }
    }
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
  const { Database } = await import(/* webpackIgnore: true */ "bun" + ":sqlite");
  mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file, { create: true });
  sqlite.exec("PRAGMA journal_mode=WAL;");
  // Per-statement tolerance: a database from an older schema can lack a column
  // a baseline index names (e.g. tool_run.created_at), and failing here bricks
  // startup BEFORE migrate() gets to add the column. migrate() below backfills
  // whatever these statements could not create.
  for (const stmt of SQLITE_STATEMENTS) {
    try {
      sqlite.exec(stmt);
    } catch {
      /* migrate() backfills */
    }
  }
  const db = new EdenDb(sqlite, null);
  await migrate(db, false);
  await seed(db);
  await hashLegacyKeys(db);
  return db;
}

/**
 * Rebuilds `cluster` when it still carries the old fingerprint-only key.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a database created before the composite key keeps the global one — and the
 * `ON CONFLICT (workspace_id, fingerprint)` upsert has no matching constraint
 * to target. Copies rows across, keeping the highest count per pair.
 */
async function alreadyTenantKeyed(db: EdenDb, neon: boolean, table: string): Promise<boolean> {
  if (neon) {
    const row = await db.get<{ n: number | string }>(
      `SELECT count(*) AS n
         FROM information_schema.table_constraints c
         JOIN information_schema.key_column_usage k ON k.constraint_name = c.constraint_name AND k.table_name = c.table_name
        WHERE c.table_name = $1 AND c.constraint_type = 'PRIMARY KEY' AND k.column_name = 'workspace_id'`,
      [table],
    );
    return Number(row?.n ?? 0) > 0;
  }
  const row = await db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
  return !row?.sql || /PRIMARY KEY\s*\(\s*workspace_id/i.test(row.sql);
}

/**
 * Re-key a table onto (workspace_id, <id>) by copying it through a v2 table.
 *
 * Shared by `cluster` and `tool_event`, which had the same fault for the same
 * reason: an id that is not globally unique used as a global primary key, so
 * one tenant's row silently displaced another's.
 */
async function migrateTenantKey(
  db: EdenDb,
  neon: boolean,
  table: string,
  idColumn: string,
  columns: string,
): Promise<void> {
  try {
    if (await alreadyTenantKeyed(db, neon, table)) return;
    const tmp = `${table}_v2`;
    await db.exec(`CREATE TABLE IF NOT EXISTS ${tmp} (
        ${columns},
        PRIMARY KEY (workspace_id, ${idColumn})
      )`);
    const names = columns
      .split(",")
      .map((c) => c.trim().split(/\s+/)[0])
      .filter(Boolean)
      .join(", ");
    await db.exec(`INSERT INTO ${tmp} (${names}) SELECT ${names} FROM ${table}`);
    await db.exec(`DROP TABLE ${table}`);
    await db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  } catch (err) {
    // A failed migration must not stop the server booting. Writes still work
    // against the old key; they just keep the old collision — which is exactly
    // why the failure cannot stay silent: an operator whose tenant isolation
    // silently degraded would never know to fix it.
    console.error(
      `[eden] tenant-isolation migration for table "${table}" FAILED; continuing with degraded cross-tenant keying:`,
      err,
    );
  }
}

async function migrate(db: EdenDb, neon: boolean) {
  if (neon) {
    await db.exec(`ALTER TABLE result_cache ALTER COLUMN expires_at TYPE BIGINT`).catch(() => undefined);
    await db.exec(`ALTER TABLE wrap_cache ALTER COLUMN created_at TYPE BIGINT`).catch(() => undefined);
  }
  await db.exec(`ALTER TABLE tool ADD COLUMN required_k INTEGER DEFAULT 2`).catch(() => undefined);
  await db.exec(`ALTER TABLE tool ADD COLUMN published INTEGER DEFAULT 0`).catch(() => undefined);
  // Rows written before created_at existed carry 0 — they are lifetime history,
  // not current-month activity, so the dashboard filter excludes them by
  // construction rather than pretending they are recent.
  await db.exec(`ALTER TABLE tool_run ADD COLUMN created_at BIGINT DEFAULT 0`).catch(() => undefined);
  // One tool per (workspace, fingerprint). The ingest path reads-then-inserts
  // on this identity everywhere; without a constraint two concurrent ingests
  // could both see "no draft yet" and mint duplicate drafts for the same
  // stretch. Best-effort like the other backfilled indexes: legacy databases
  // holding duplicates must not block boot.
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_ws_fp ON tool (workspace_id, fingerprint)`).catch(() => undefined);
  // Timestamps for the TTL housekeeping sweeps. Old rows carry 0, so a fresh
  // deployment's history is not immediately swept; it ages out on its own
  // schedule once real timestamps exist.
  await db.exec(`ALTER TABLE tool_event ADD COLUMN created_at BIGINT DEFAULT 0`).catch(() => undefined);
  await db.exec(`ALTER TABLE stretch ADD COLUMN created_at BIGINT DEFAULT 0`).catch(() => undefined);
  await migrateTenantKey(db, neon, "cluster", "fingerprint", "fingerprint TEXT, workspace_id TEXT, count INTEGER, steps TEXT, status TEXT");
  await migrateTenantKey(
    db,
    neon,
    "tool_event",
    "event_id",
    "event_id TEXT, workspace_id TEXT, run_id TEXT, seq INTEGER, name TEXT, args TEXT, command TEXT, ok INTEGER",
  );
  // One observation per (workspace, run, island). The ingest path guards with
  // a read-then-insert, which has no constraint behind it: two concurrent
  // ingests of the same run both passed the dup-check and both counted toward
  // the knock threshold — one observed stretch could look like two. Best-effort
  // because databases created before this index can hold duplicate rows, and
  // creating a unique index over duplicates must not stop the server booting.
  await db
    .exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stretch_observed ON stretch (workspace_id, run_id, fingerprint, island_index)`)
    .catch(() => undefined);
  // Drift canary ledger: one row per caught DeoptError during playback. The
  // autoincrement id is the spec'd shape for SQLite; Neon cannot parse
  // AUTOINCREMENT, so the managed branch creates its own SERIAL-flavored twin.
  // Best-effort like every other backfill here — a failed ledger must not stop
  // the server booting, it would only mean deopts go unwitnessed.
  if (neon) {
    await db
      .exec(
        `CREATE TABLE IF NOT EXISTS deopt_event (
           id SERIAL PRIMARY KEY,
           workspace_id TEXT NOT NULL,
           tool_id TEXT NOT NULL,
           reason TEXT,
           steps_run INTEGER,
           created_at BIGINT DEFAULT 0
         )`,
      )
      .catch(() => undefined);
  } else {
    await db
      .exec(
        `CREATE TABLE IF NOT EXISTS deopt_event (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           workspace_id TEXT NOT NULL,
           tool_id TEXT NOT NULL,
           reason TEXT,
           steps_run INTEGER,
           created_at INTEGER
         )`,
      )
      .catch(() => undefined);
  }
  await db
    .exec(`CREATE INDEX IF NOT EXISTS idx_deopt_tool_created ON deopt_event (workspace_id, tool_id, created_at)`)
    .catch(() => undefined);
}

/**
 * Ledger one caught DeoptError against a tool.
 *
 * Called off playback's response path, so it swallows its own failures: losing
 * a drift observation is recoverable (the next deopt records one), while an
 * insert error surfacing into a /v1/play response that already did its work is
 * not.
 */
export async function recordDeopt(
  db: EdenDb,
  workspaceId: string,
  toolId: string,
  opts: { reason?: string; steps_run?: number } = {},
): Promise<void> {
  try {
    await db.run(`INSERT INTO deopt_event (workspace_id, tool_id, reason, steps_run, created_at) VALUES (?, ?, ?, ?, ?)`, [
      workspaceId,
      toolId,
      opts.reason ?? null,
      Number.isFinite(opts.steps_run) ? Number(opts.steps_run) : 0,
      Date.now(),
    ]);
  } catch {
    /* best-effort by contract */
  }
}

/** How many deopts a tool accumulated inside the trailing window. */
export async function countDeopts(
  db: EdenDb,
  workspaceId: string,
  toolId: string,
  windowMs = 24 * 60 * 60_000,
): Promise<number> {
  const row = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM deopt_event WHERE workspace_id = ? AND tool_id = ? AND created_at >= ?`,
    [workspaceId, toolId, Date.now() - windowMs],
  );
  return Number(row?.n ?? 0);
}

export async function listDeopts(
  db: EdenDb,
  workspaceId: string,
  toolId: string,
  limit = 20,
): Promise<Array<{ id: number; tool_id: string; reason: string | null; steps_run: number | null; created_at: number }>> {
  return db.all(
    `SELECT id, tool_id, reason, steps_run, created_at FROM deopt_event
      WHERE workspace_id = ? AND tool_id = ? ORDER BY created_at DESC LIMIT ?`,
    [workspaceId, toolId, limit],
  );
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
export function isManagedDeployment(): boolean {
  return Boolean(process.env.DATABASE_URL) || Boolean(process.env.VERCEL);
}

/**
 * Marker for an api_key row that can never authenticate.
 *
 * Deliberately not 64 hex characters, so it cannot collide with a real
 * sha256 and cannot be produced by hashing any token.
 */
const DISABLED_HASH = "disabled";

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
 *
 * This runs on every boot, so it has to be idempotent, and it was not. A row
 * disabled on the first boot came back on the second: "disabled" is truthy and
 * is not 64 hex characters, so it fell through to the last line and was stored
 * as sha256("disabled"). From then on the literal token `disabled`
 * authenticated into that row's workspace. Deployments that had booted twice
 * are repaired here as well as protected, since the damage is already in their
 * database.
 */
async function hashLegacyKeys(db: EdenDb) {
  const disabledHashed = hashApiKey(DISABLED_HASH);
  const rows = await db.all<{ prefix: string; hash: string | null }>(`SELECT prefix, hash FROM api_key`);
  for (const row of rows) {
    if (row.hash === DISABLED_HASH) continue;
    if (row.hash === disabledHashed) {
      // Left behind by the non-idempotent version of this migration. As it
      // stands, presenting the word "disabled" as a key authenticates.
      await db.run(`UPDATE api_key SET hash = ? WHERE prefix = ?`, [DISABLED_HASH, row.prefix]);
      continue;
    }
    if (row.hash && /^[0-9a-f]{64}$/.test(row.hash)) continue;
    if (!row.hash) {
      // A row with no secret cannot be migrated into one. Falling back to the
      // prefix here would hash the *non-secret* row label and store it as the
      // credential, so presenting a key's public identifier would authenticate
      // — exactly the hole the prefix-matching removal closed. Disable the row
      // instead; a key nobody can use is the safe failure.
      await db.run(`UPDATE api_key SET hash = ? WHERE prefix = ?`, [DISABLED_HASH, row.prefix]);
      continue;
    }
    await db.run(`UPDATE api_key SET hash = ? WHERE prefix = ?`, [hashApiKey(row.hash), row.prefix]);
  }
}

/**
 * Whether a caller with no key, or an unknown `eden_` key, is let into ws_local: on a laptop
 * unless EDEN_DEV=0, on a managed deployment only with EDEN_DEV=1.
 */
export function devFallbackEnabled(): boolean {
  return isManagedDeployment() ? process.env.EDEN_DEV === "1" : process.env.EDEN_DEV !== "0";
}

export async function workspaceForKey(db: EdenDb, auth: string | null): Promise<string | null> {
  const token = auth?.replace(/^Bearer\s+/i, "") || "";
  const devFallback = devFallbackEnabled();
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
