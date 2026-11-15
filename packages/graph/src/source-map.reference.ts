/**
 * THE REFERENCE (not exported): `source-map.ts` as it stood before D1935-D1937 (main 7bca42093), unchanged below this
 * paragraph. `source-map-fast.test.ts` runs both on random streams of every call and holds them to the same answers.
 *
 * The source map: the first layer of the knowledge graph. It records, per user, which sources have mentioned which
 * entities (people, companies, projects, ids), and how useful each source has proven in each situation. Routing
 * reads both, so the partner asks the two sources likely to know instead of all twelve.
 *
 * It holds no content: entity names, source ids, item refs, counts, and the query planner's per-shape counts. Content
 * stays at the source or in the short-lived item cache. Everything is partitioned by scope key (tenant/user); no query
 * crosses it.
 *
 * Statements go through `db.query`, which caches the prepared statement (re-preparing per call was 5% of end-to-end
 * CPU; packages/engine/bench/pipeline.bench.ts).
 *
 * Outcomes are written behind: buffered, then written in one transaction within `OUTCOME_FLUSH_MS` (or at 256 rows),
 * and every read flushes first, so reads always see them. With WAL and synchronous=NORMAL, a file-backed outcome costs
 * ~2 µs instead of ~190 µs (an fsync per commit, on the event loop); a crash loses at most the last few milliseconds
 * of counts, which learning shrugs off (docs/research/primitives.md).
 *
 * Mentions are written behind too (D1780): a lookup's mentions are summed in memory per (user, entity, source) and
 * written in one transaction within `MENTION_FLUSH_MS` (1 s, or at `MENTION_FLUSH_ROWS` distinct rows), which cut the
 * file's disk writes about 4x on the pipeline bench (each commit rewrites every B-tree page it touches into the WAL).
 * Reads of mentions (`sourcesFor`, so `route`) add the pending counts to what the file holds instead of flushing, or
 * every lookup's route would commit the last lookup's mentions and batch nothing; `exportUser`, `importUser`, `forget`
 * and `close` flush first. What is lost when a process dies: never a committed row (a batch is one transaction), at
 * most the mentions not yet written: the last second's, plus a batch a locked or full file refused, held for a retry
 * up to `MENTION_RETAIN_ROWS`. A process that exits normally writes them (`process.on("exit")`); SIGKILL, a power cut,
 * and a terminating signal in a process with no handler for it do not run that listener, so the servers close the map
 * on SIGTERM, SIGINT and SIGHUP (main.ts, mcp-stdio.ts). Mentions are routing evidence, learned again from the next
 * lookups that find the same names. Another process on the same file (D15) sees them up to a second late.
 *
 * Learning is a Beta-Bernoulli estimate per (user, situation, source): `shown` counts injections that cited the
 * source, `used` those the agent then used. The mean (used+1)/(shown+2) starts at 0.5 and moves with evidence.
 */
import { Database } from "bun:sqlite";
import { Xoshiro128 } from "@eden/primitives";
import { scopeKey, type Scope } from "@eden/protocol";

export interface RouteRequest {
  scope: Scope;
  entities: string[];
  situation: string;
  /** All sources the user has; routing ranks them. */
  sourceIds: string[];
  limit: number;
  /**
   * Evidence from the user's own index, added to each source's score (`routeLocalHits`, D265): how many of the
   * request's best local matches each source holds. Absent: none.
   */
  boost?: ReadonlyMap<string, number>;
}

export interface RankedSource {
  sourceId: string;
  score: number;
  /** Why it ranked: entity hits, the learned usefulness (posterior mean) and the value routing drew for it. */
  entityHits: number;
  utility: number;
  sampled: number;
}

export interface SourceMapOptions {
  /**
   * Thompson sampling in routing (default true): each source's usefulness is drawn from its Beta posterior instead of
   * taken as the mean, so a source that has been unlucky (or is new) still gets queried sometimes and can recover.
   * Exploration only decides which sources to *query*; it never lowers the bar for *injecting* anything.
   * Simulated regret per decision with 30 sources, 3 queried: 0.0467 vs 0.1538 for the posterior mean
   * (docs/research/primitives-decision.md). Pass false for deterministic routing, or a seed.
   */
  explore?: boolean;
  seed?: number;
  /** How long mentions wait in memory before their transaction (D1780; default 1 s). Tests shorten it. */
  mentionFlushMs?: number;
}

const OUTCOME_FLUSH_MS = 10;
const OUTCOME_FLUSH_ROWS = 256;
const MENTION_FLUSH_MS = 1_000;
/** Distinct pending (user, entity, source) rows that flush at once: bounds the buffer to about a megabyte. */
const MENTION_FLUSH_ROWS = 4_096;
/**
 * The most pending rows held while writes fail (SQLITE_BUSY past the busy timeout, a full disk): a refused batch is
 * put back for the next flush unless that would hold more than this, and is then dropped and counted
 * (`droppedMentionRows`), so a lock that never clears cannot grow memory without bound.
 */
const MENTION_RETAIN_ROWS = 4 * MENTION_FLUSH_ROWS;
/** How long a statement waits for another process's write lock on the same file before SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 2_000;

export class SourceMap {
  private readonly db: Database;
  private pending: [scope: string, situation: string, sourceId: string, used: number][] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Mentions not yet written (D1780): scope key → entity → source id → [count to add, last seen]. */
  private mentions = new Map<string, Map<string, Map<string, [count: number, lastSeen: number]>>>();
  private mentionRows = 0;
  private mentionTimer: ReturnType<typeof setTimeout> | undefined;
  /** A write of mentions failed and its rows wait: the buffer may pass `MENTION_FLUSH_ROWS` until the timer retries. */
  private mentionRetrying = false;
  private closed = false;
  /** This map's entry in `OPEN` (file-backed maps only). */
  private ref: WeakRef<SourceMap> | undefined;
  private readonly mentionFlushMs: number;

  private readonly explore: boolean;
  private readonly rng: Xoshiro128;

  constructor(path = ":memory:", options: SourceMapOptions = {}) {
    this.explore = options.explore ?? true;
    this.mentionFlushMs = options.mentionFlushMs ?? MENTION_FLUSH_MS;
    this.rng = new Xoshiro128(options.seed ?? (Math.random() * 2 ** 32) >>> 0);
    this.db = new Database(path, { create: true });
    // First, so the WAL switch and the schema below wait too: two processes on one file (two MCP clients launching
    // mcp-stdio for one user) otherwise fail with SQLITE_BUSY at once, in this constructor or in a write. Writes here
    // are short transactions, so a wait is milliseconds; with one process per file, as the HTTP server runs, it never
    // waits at all.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mention (
        scope TEXT NOT NULL, entity TEXT NOT NULL, source_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL,
        PRIMARY KEY (scope, entity, source_id)
      );
      CREATE TABLE IF NOT EXISTS utility (
        scope TEXT NOT NULL, situation TEXT NOT NULL, source_id TEXT NOT NULL,
        shown INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, situation, source_id)
      );
      CREATE TABLE IF NOT EXISTS planner_arm (
        scope TEXT NOT NULL, source_id TEXT NOT NULL, bucket INTEGER NOT NULL, shape TEXT NOT NULL,
        alpha REAL NOT NULL, beta REAL NOT NULL,
        PRIMARY KEY (scope, source_id, bucket, shape)
      );
    `);
    if (path !== ":memory:" && path !== "") {
      OPEN.add((this.ref = new WeakRef(this)));
      CLOSED_BY_GC.register(this, this.ref, this.ref);
    }
  }

  /**
   * Records that `sourceId` returned an item mentioning these entities. The caller passes typed entities only
   * (names, handles, ids): never quoted phrases, URLs or item refs, which can carry content.
   */
  recordMentions(scope: Scope, sourceId: string, entities: string[], now = Date.now()): void {
    this.recordMentionsMany(scope, [{ sourceId, entities }], now);
  }

  /**
   * As `recordMentions` for many items: a lookup's results are recorded together. Since D1780 they are summed in
   * memory and written with every other mention of the next second in one transaction (one transaction a lookup cost
   * 0.47-0.53 ms and about 1.4 KB of disk writes a mention; packages/graph/CLAUDE.md).
   */
  recordMentionsMany(scope: Scope, rows: { sourceId: string; entities: string[] }[], now = Date.now()): void {
    const key = scopeKey(scope);
    let byEntity = this.mentions.get(key);
    for (const row of rows) {
      for (const e of new Set(row.entities.map(normalizeEntity))) {
        if (!e) continue;
        if (!byEntity) this.mentions.set(key, (byEntity = new Map()));
        let bySource = byEntity.get(e);
        if (!bySource) byEntity.set(e, (bySource = new Map()));
        const held = bySource.get(row.sourceId);
        if (held) {
          held[0]++;
          held[1] = now;
        } else {
          bySource.set(row.sourceId, [1, now]);
          this.mentionRows++;
        }
      }
    }
    // A full buffer is written by the lookup that filled it, through the background path: a refused write is logged,
    // counted and kept for the timer's retry, never thrown into the lookup. While a retry is due the buffer may grow
    // to `MENTION_RETAIN_ROWS` before a lookup tries again, so a held lock does not cost every lookup a busy wait.
    if (this.mentionRows >= (this.mentionRetrying ? MENTION_RETAIN_ROWS : MENTION_FLUSH_ROWS)) {
      this.flushMentionsInBackground();
    } else this.armMentionTimer();
  }

  private armMentionTimer(): void {
    if (this.mentionRows === 0 || this.mentionTimer !== undefined || this.closed) return;
    this.mentionTimer = setTimeout(() => this.flushMentionsInBackground(), this.mentionFlushMs);
    // A pending batch never holds a process open: a normal exit flushes it (`OPEN`), a crash loses it (D1780).
    this.mentionTimer.unref?.();
  }

  /** Mention rows dropped because writes kept failing past `MENTION_RETAIN_ROWS` (content-free count). */
  droppedMentionRows = 0;

  /** The timer's (and a full buffer's) mention flush: as `flushInBackground`, nothing may throw out of it. */
  private flushMentionsInBackground(): void {
    try {
      this.flushMentions();
    } catch (e) {
      this.failedFlushes++;
      // The error only: never the rows, which hold user ids and entity names.
      console.error("eden: source-map mention write failed", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Writes buffered mentions now, in one transaction. A refused write puts its rows back (`putBack`) for the timer to
   * try again, then throws to its caller: the background path logs it, `flush`'s callers see it as before.
   */
  private flushMentions(): void {
    if (this.mentionTimer !== undefined) clearTimeout(this.mentionTimer);
    this.mentionTimer = undefined;
    if (this.mentionRows === 0) return;
    const pending = this.mentions;
    const rows = this.mentionRows;
    this.mentions = new Map();
    this.mentionRows = 0;
    // `count + excluded.count` and the last mention's time: the row one upsert a mention would have left.
    const upsert = this.db.query(`
      INSERT INTO mention (scope, entity, source_id, count, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (scope, entity, source_id) DO UPDATE SET count = count + excluded.count, last_seen = excluded.last_seen
    `);
    try {
      this.db.transaction(() => {
        for (const [key, byEntity] of pending) {
          for (const [entity, bySource] of byEntity) {
            for (const [sourceId, [count, lastSeen]] of bySource) upsert.run(key, entity, sourceId, count, lastSeen);
          }
        }
      })();
    } catch (e) {
      this.putBack(pending, rows);
      throw e;
    }
    this.mentionRetrying = false;
  }

  /**
   * A refused batch back into the buffer (counts added, the later time kept), unless the buffer would then pass
   * `MENTION_RETAIN_ROWS`: then it is dropped and counted. The timer is armed for the retry.
   */
  private putBack(batch: Map<string, Map<string, Map<string, [number, number]>>>, rows: number): void {
    if (this.closed) return;
    if (this.mentionRows + rows > MENTION_RETAIN_ROWS) {
      this.droppedMentionRows += rows;
      this.mentionRetrying = false;
      return;
    }
    for (const [key, byEntity] of batch) {
      let into = this.mentions.get(key);
      if (!into) this.mentions.set(key, (into = new Map()));
      for (const [entity, bySource] of byEntity) {
        let sources = into.get(entity);
        if (!sources) into.set(entity, (sources = new Map()));
        for (const [sourceId, [count, lastSeen]] of bySource) {
          const held = sources.get(sourceId);
          if (held) {
            held[0] += count;
            held[1] = Math.max(held[1], lastSeen);
          } else {
            sources.set(sourceId, [count, lastSeen]);
            this.mentionRows++;
          }
        }
      }
    }
    this.mentionRetrying = true;
    this.armMentionTimer();
  }

  /** Records whether an injection citing `sourceId` was used, in this situation. */
  recordOutcome(scope: Scope, situation: string, sourceId: string, used: boolean): void {
    this.pending.push([scopeKey(scope), situation, sourceId, used ? 1 : 0]);
    if (this.pending.length >= OUTCOME_FLUSH_ROWS) this.flushOutcomes();
    else this.flushTimer ??= setTimeout(() => this.flushInBackground(), OUTCOME_FLUSH_MS);
  }

  /** Batches a timer could not write (SQLITE_BUSY, a full disk); they are lost, learning goes on. */
  failedFlushes = 0;

  /** The timer's flush: nothing may throw out of a timer (it would take the process down). */
  private flushInBackground(): void {
    try {
      this.flushOutcomes();
    } catch (e) {
      this.failedFlushes++;
      // The error only: never the rows, which hold user and source ids.
      console.error("eden: source-map outcome write failed", e instanceof Error ? e.message : String(e));
    }
  }

  /** Writes everything buffered (outcomes and mentions) now. */
  flush(): void {
    this.flushOutcomes();
    this.flushMentions();
  }

  /** Writes buffered outcomes now, in one transaction. Reads of outcomes call it first. */
  private flushOutcomes(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pending.length === 0) return;
    const rows = this.pending;
    this.pending = [];
    const upsert = this.db.query(
      `INSERT INTO utility (scope, situation, source_id, shown, used) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (scope, situation, source_id) DO UPDATE SET shown = shown + 1, used = used + excluded.used`,
    );
    this.db.transaction(() => {
      for (const row of rows) upsert.run(...row);
    })();
  }

  /** Corrects an outcome recorded earlier (explicit feedback overriding an inferred one). Counts never go negative. */
  correctOutcome(scope: Scope, situation: string, sourceId: string, used: boolean): void {
    this.flushOutcomes();
    const delta = used ? 1 : -1;
    this.db
      .query(
        `UPDATE utility SET used = MAX(0, MIN(shown, used + ?)) WHERE scope = ? AND situation = ? AND source_id = ?`,
      )
      .run(delta, scopeKey(scope), situation, sourceId);
  }

  /** The learned usefulness of a source in a situation: the Beta(1,1) posterior mean. */
  utility(scope: Scope, situation: string, sourceId: string): number {
    const { shown, used } = this.outcomes(scope, situation, sourceId);
    return (used + 1) / (shown + 2);
  }

  private outcomes(scope: Scope, situation: string, sourceId: string): { shown: number; used: number } {
    this.flushOutcomes();
    const row = this.db
      .query("SELECT shown, used FROM utility WHERE scope = ? AND situation = ? AND source_id = ?")
      .get(scopeKey(scope), situation, sourceId) as { shown: number; used: number } | null;
    return { shown: row?.shown ?? 0, used: row?.used ?? 0 };
  }

  /** Every source's outcomes in a situation for a user, by source id (sources with none are absent). */
  private outcomesIn(scope: Scope, situation: string): Map<string, { shown: number; used: number }> {
    this.flushOutcomes();
    const rows = this.db
      .query("SELECT source_id AS sourceId, shown, used FROM utility WHERE scope = ? AND situation = ?")
      .all(scopeKey(scope), situation) as { sourceId: string; shown: number; used: number }[];
    return new Map(rows.map((r) => [r.sourceId, { shown: r.shown, used: r.used }]));
  }

  /**
   * Which sources have mentioned an entity, most often first (ties by source id). Pending mentions (D1780) are added
   * to the file's counts, so a read sees every mention recorded, written yet or not.
   */
  sourcesFor(scope: Scope, entity: string): { sourceId: string; count: number }[] {
    const key = scopeKey(scope);
    const e = normalizeEntity(entity);
    const rows = this.db
      .query(
        "SELECT source_id AS sourceId, count FROM mention WHERE scope = ? AND entity = ? ORDER BY count DESC, source_id",
      )
      .all(key, e) as { sourceId: string; count: number }[];
    const pending = this.mentions.get(key)?.get(e);
    if (!pending) return rows;
    const added = new Map(pending);
    for (const row of rows) {
      const held = added.get(row.sourceId);
      if (held) {
        row.count += held[0];
        added.delete(row.sourceId);
      }
    }
    for (const [sourceId, [count]] of added) rows.push({ sourceId, count });
    // SQLite's text order is by bytes; `<` on JS strings is by UTF-16 units, the same order for any id without
    // characters past U+FFFF, which ids (`isId`) never hold.
    return rows.sort((a, b) => b.count - a.count || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  }

  /**
   * Ranks sources for a lookup. A source that has mentioned the cue's entities ranks first; learned utility
   * breaks ties and lifts sources that have been useful in this situation. Sources with no evidence keep a floor
   * score, so a new source is still tried and can earn its place.
   */
  route(request: RouteRequest): RankedSource[] {
    const hits = new Map<string, number>();
    for (const entity of request.entities) {
      for (const { sourceId, count } of this.sourcesFor(request.scope, entity)) {
        hits.set(sourceId, (hits.get(sourceId) ?? 0) + Math.log2(1 + count));
      }
    }
    // The situation's outcomes for every source in one query (D261): one query per source cost a user with 1,000
    // connectors 1,000 queries a route, and a lookup routes several times (its search, each person probe).
    const known = this.outcomesIn(request.scope, request.situation);
    return request.sourceIds
      .map((sourceId) => {
        const entityHits = hits.get(sourceId) ?? 0;
        const { shown, used } = known.get(sourceId) ?? NONE;
        const utility = (used + 1) / (shown + 2);
        const sampled = this.explore ? this.rng.beta(used + 1, shown - used + 1) : utility;
        const boost = request.boost?.get(sourceId) ?? 0;
        return { sourceId, entityHits, utility, sampled, score: entityHits + boost + 2 * sampled };
      })
      .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
      .slice(0, request.limit);
  }

  /**
   * The query planner's learned arms for one user's connector (`QueryPlanner`'s store): content-free, a shape name and
   * two Beta parameters per (bucket, shape). Shapes and numbers are checked by the planner when loaded.
   */
  loadArms(scope: Scope, sourceId: string): { bucket: number; shape: string; alpha: number; beta: number }[] {
    return this.db
      .query("SELECT bucket, shape, alpha, beta FROM planner_arm WHERE scope = ? AND source_id = ?")
      .all(scopeKey(scope), sourceId) as { bucket: number; shape: string; alpha: number; beta: number }[];
  }

  saveArms(
    scope: Scope,
    sourceId: string,
    arms: { bucket: number; shape: string; alpha: number; beta: number }[],
  ): void {
    const key = scopeKey(scope);
    const upsert = this.db.query(
      `INSERT INTO planner_arm (scope, source_id, bucket, shape, alpha, beta) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, source_id, bucket, shape) DO UPDATE SET alpha = excluded.alpha, beta = excluded.beta`,
    );
    for (const a of arms) upsert.run(key, sourceId, a.bucket, a.shape, a.alpha, a.beta);
  }

  /**
   * Every row held for a user (D992), to carry with them to another process or machine in their persisted blob:
   * columns in table order, scope left out (the importer's is used). Entity names, source ids and counts: what this
   * file holds anyway, no content (D8).
   */
  exportUser(scope: Scope): UserRows {
    this.flush();
    const key = scopeKey(scope);
    const rows = (sql: string) => this.db.query(sql).values(key) as (string | number)[][];
    return {
      mention: rows("SELECT entity, source_id, count, last_seen FROM mention WHERE scope = ?"),
      utility: rows("SELECT situation, source_id, shown, used FROM utility WHERE scope = ?"),
      arms: rows("SELECT source_id, bucket, shape, alpha, beta FROM planner_arm WHERE scope = ?"),
    };
  }

  /**
   * Replaces a user's rows with carried ones (D992): what the blob holds is at least as new as anything this file
   * holds for them (a process that served them since would have written a newer blob). Malformed rows are skipped,
   * never written: the blob is authenticated, but its extra is still parsed input.
   */
  importUser(scope: Scope, rows: UserRows): void {
    this.forget(scope);
    const key = scopeKey(scope);
    const str = (v: unknown) => typeof v === "string";
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    const each = (list: unknown, ok: (r: unknown[]) => boolean, run: (r: unknown[]) => void) => {
      if (!Array.isArray(list)) return;
      for (const r of list) if (Array.isArray(r) && ok(r)) run(r);
    };
    const m = this.db.query("INSERT OR REPLACE INTO mention VALUES (?, ?, ?, ?, ?)");
    const u = this.db.query("INSERT OR REPLACE INTO utility VALUES (?, ?, ?, ?, ?)");
    const a = this.db.query("INSERT OR REPLACE INTO planner_arm VALUES (?, ?, ?, ?, ?, ?)");
    type V = string | number;
    this.db.transaction(() => {
      each(
        rows.mention,
        (r) => str(r[0]) && str(r[1]) && num(r[2]) && num(r[3]),
        (r) => {
          m.run(key, r[0] as V, r[1] as V, r[2] as V, r[3] as V);
        },
      );
      each(
        rows.utility,
        (r) => str(r[0]) && str(r[1]) && num(r[2]) && num(r[3]),
        (r) => {
          u.run(key, r[0] as V, r[1] as V, r[2] as V, r[3] as V);
        },
      );
      each(
        rows.arms,
        (r) => str(r[0]) && num(r[1]) && str(r[2]) && num(r[3]) && num(r[4]),
        (r) => {
          a.run(key, r[0] as V, r[1] as V, r[2] as V, r[3] as V, r[4] as V);
        },
      );
    })();
  }

  /** Deletes everything held for a user (account deletion, connector revocation). */
  forget(scope: Scope, sourceId?: string): void {
    this.flush();
    const key = scopeKey(scope);
    for (const table of ["mention", "utility", "planner_arm"]) {
      if (sourceId) this.db.query(`DELETE FROM ${table} WHERE scope = ? AND source_id = ?`).run(key, sourceId);
      else this.db.query(`DELETE FROM ${table} WHERE scope = ?`).run(key);
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.ref) {
      OPEN.delete(this.ref);
      CLOSED_BY_GC.unregister(this.ref);
    }
    this.db.close();
  }

  /** How many file-backed maps the exit listener would flush (tests: dead ones leave through `CLOSED_BY_GC`). */
  static openCount(): number {
    return OPEN.size;
  }

  /** At a normal process exit: what every open map holds buffered is written (synchronously, as `exit` needs). */
  static flushAllOpen(): void {
    for (const ref of OPEN) {
      try {
        ref.deref()?.flush();
      } catch (e) {
        console.error("eden: source-map write at exit failed", e instanceof Error ? e.message : String(e));
      }
    }
  }
}

/** A user's rows (D992), as `exportUser` gives them: arrays of column values, in the table's column order. */
export interface UserRows {
  mention: (string | number)[][];
  utility: (string | number)[][];
  arms: (string | number)[][];
}

const NONE = { shown: 0, used: 0 } as const;

/**
 * File-backed maps not yet closed, flushed at a normal exit (D1780: an mcp-stdio process ends when its client closes
 * stdin and never calls `close`). One listener for the module, not one a map. Held weakly: the lab builds an
 * in-memory map a task and never closes it, and a strong set would keep every one alive (in-memory maps are not
 * registered at all: nothing outlives the process). A map dropped with mentions pending is still held by its timer
 * until the timer writes them.
 */
const OPEN = new Set<WeakRef<SourceMap>>();
/** Takes a collected map's dead `WeakRef` out of `OPEN`, so a process that drops maps does not keep their entries. */
const CLOSED_BY_GC = new FinalizationRegistry<WeakRef<SourceMap>>((ref) => OPEN.delete(ref));
process.on("exit", () => SourceMap.flushAllOpen());

export function normalizeEntity(e: string): string {
  return e.trim().toLowerCase().replace(/\s+/g, " ");
}
