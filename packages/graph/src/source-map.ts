/**
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
import { accessSync, constants as fsConstants, statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
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

  /**
   * The file's mention rows per (user, entity), as `sourcesFor`'s query returns them (count descending, then source
   * id), and its outcomes per (user, situation), as `outcomesIn` reads them (D1935): a lookup routes the same names
   * several times (its search, each person probe, the earn rule's holders), and 97% of the pipeline bench's mention
   * reads repeated one before. Exact: emptied by every write of its table this connection makes (`flushMentions`,
   * `flushOutcomes`, `correctOutcome`, `importUser`, `forget`), and for a file, which another process may write (D15),
   * whenever `PRAGMA data_version` says another connection committed (`fresh`). Each holds at most `MEMO_MAX`
   * keys and rows together, then is emptied whole. Keyed by scope key first: one user's reads never answer
   * another's (D9).
   */
  private mentionMemo = new Map<string, Map<string, [sourceId: string, count: number][]>>();
  private mentionMemoSize = 0;
  private outcomeMemo = new Map<string, Map<string, Map<string, { shown: number; used: number }>>>();
  private outcomeMemoSize = 0;
  /** A file another connection may write (null for a private in-memory or temporary database). */
  private readonly version: { values(): unknown[][] } | null;
  private lastVersion = -1;
  private readonly mentionRead: { values(...args: string[]): unknown[][] };
  private readonly outcomesRead: { values(...args: string[]): unknown[][] };

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
    // WITHOUT ROWID (D1936): each table is its primary key's B-tree alone. With a rowid every row was stored twice
    // (the table and the key's automatic index), so a file held about twice the pages. A file made before is moved to
    // this layout once, here (D1960, `migrateLayout`); one it cannot move (read-only, locked, full, damaged) keeps its
    // rowid tables and reads and writes as it did: every statement here names its columns, and a user's rows are read
    // in the key's order in either layout (`source-map-fast.test.ts` holds both to the same rows).
    this.db.exec(TABLES.map((t) => `CREATE TABLE IF NOT EXISTS ${t} ${TABLE_SQL[t]};`).join("\n"));
    if (path !== ":memory:" && path !== "") migrateLayout(this.db);
    this.mentionRead = this.db.query(
      "SELECT source_id, count FROM mention WHERE scope = ? AND entity = ? ORDER BY count DESC, source_id",
    );
    this.outcomesRead = this.db.query("SELECT source_id, shown, used FROM utility WHERE scope = ? AND situation = ?");
    this.version = path === ":memory:" || path === "" ? null : this.db.query("PRAGMA data_version");
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
    // An item's names counted once each, in their first order (a Set a row before; one Set a call, D1937).
    const seen = new Set<string>();
    for (const row of rows) {
      seen.clear();
      for (const raw of row.entities) {
        const e = normalizeEntity(raw);
        if (!e || seen.has(e)) continue;
        seen.add(e);
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
    this.clearMentionMemo();
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
    this.clearOutcomeMemo();
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
    this.clearOutcomeMemo();
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
    const key = scopeKey(scope);
    let bySituation = this.outcomeMemo.get(key);
    const held = bySituation?.get(situation);
    if (held) return held;
    const rows = this.outcomesRead.values(key, situation) as [string, number, number][];
    const known = new Map(rows.map((r) => [r[0], { shown: r[1], used: r[2] }]));
    // A read larger than the whole cap is answered unheld, so the cap is strict.
    if (rows.length + 1 > MEMO_MAX) return known;
    if (this.outcomeMemoSize + rows.length + 1 > MEMO_MAX) this.clearOutcomeMemo();
    if (!bySituation || this.outcomeMemoSize === 0) this.outcomeMemo.set(key, (bySituation = new Map()));
    bySituation.set(situation, known);
    this.outcomeMemoSize += rows.length + 1;
    return known;
  }

  /** For a file: empties both memos if another connection committed since the last look (D1935). */
  private fresh(): void {
    if (this.version === null) return;
    const v = this.version.values()[0]![0] as number;
    if (v === this.lastVersion) return;
    this.lastVersion = v;
    this.clearMentionMemo();
    this.clearOutcomeMemo();
  }

  private clearMentionMemo(): void {
    if (this.mentionMemoSize === 0) return;
    this.mentionMemo = new Map();
    this.mentionMemoSize = 0;
  }

  private clearOutcomeMemo(): void {
    if (this.outcomeMemoSize === 0) return;
    this.outcomeMemo = new Map();
    this.outcomeMemoSize = 0;
  }

  /** The file's rows for a normalised entity (count descending, then source id), through the memo. */
  private fileRows(key: string, e: string): [sourceId: string, count: number][] {
    let byEntity = this.mentionMemo.get(key);
    const held = byEntity?.get(e);
    if (held) return held;
    const rows = this.mentionRead.values(key, e) as [string, number][];
    if (rows.length + 1 > MEMO_MAX) return rows;
    if (this.mentionMemoSize + rows.length + 1 > MEMO_MAX) this.clearMentionMemo();
    if (!byEntity || this.mentionMemoSize === 0) this.mentionMemo.set(key, (byEntity = new Map()));
    byEntity.set(e, rows);
    this.mentionMemoSize += rows.length + 1;
    return rows;
  }

  /**
   * Which sources have mentioned an entity, most often first (ties by source id). Pending mentions (D1780) are added
   * to the file's counts, so a read sees every mention recorded, written yet or not.
   */
  sourcesFor(scope: Scope, entity: string): { sourceId: string; count: number }[] {
    this.fresh();
    return this.sourcesOf(scopeKey(scope), entity);
  }

  /** `sourcesFor` past the freshness check (`route` makes it once for all its reads). */
  private sourcesOf(key: string, entity: string): { sourceId: string; count: number }[] {
    const e = normalizeEntity(entity);
    const file = this.fileRows(key, e);
    // Fresh objects each read: the memo's rows are never handed out (the merge below adds to a row's count).
    const rows = new Array<{ sourceId: string; count: number }>(file.length);
    for (let i = 0; i < file.length; i++) rows[i] = { sourceId: file[i]![0], count: file[i]![1] };
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
    this.fresh();
    const key = scopeKey(request.scope);
    for (const entity of request.entities) {
      for (const { sourceId, count } of this.sourcesOf(key, entity)) {
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
    this.clearMentionMemo();
    this.clearOutcomeMemo();
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

/** The map's tables, in the order they are created and moved (D1960). */
const TABLES = ["mention", "utility", "planner_arm"] as const;
type Table = (typeof TABLES)[number];

/** Each table's columns and key, WITHOUT ROWID (D1936): the one definition a new file and `migrateLayout` use. */
const TABLE_SQL: Record<Table, string> = {
  mention: `(
    scope TEXT NOT NULL, entity TEXT NOT NULL, source_id TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL,
    PRIMARY KEY (scope, entity, source_id)
  ) WITHOUT ROWID`,
  utility: `(
    scope TEXT NOT NULL, situation TEXT NOT NULL, source_id TEXT NOT NULL,
    shown INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, situation, source_id)
  ) WITHOUT ROWID`,
  planner_arm: `(
    scope TEXT NOT NULL, source_id TEXT NOT NULL, bucket INTEGER NOT NULL, shape TEXT NOT NULL,
    alpha REAL NOT NULL, beta REAL NOT NULL,
    PRIMARY KEY (scope, source_id, bucket, shape)
  ) WITHOUT ROWID`,
};

/** Each table's columns in order: a rowid table with any other set (an October 27 file's `last_ref`) is not moved. */
const COLUMNS: Record<Table, readonly string[]> = {
  mention: ["scope", "entity", "source_id", "count", "last_seen"],
  utility: ["scope", "situation", "source_id", "shown", "used"],
  planner_arm: ["scope", "source_id", "bucket", "shape", "alpha", "beta"],
};
/** How many of `COLUMNS`' first columns are the primary key. */
const KEY_COLUMNS: Record<Table, number> = { mention: 3, utility: 3, planner_arm: 4 };

/**
 * How long the move waits for another connection's write lock before it gives up for this open (D1960): a second
 * mcp-stdio for the same user holding the file, or one moving it at the same moment. The next open tries again.
 */
export const MIGRATE_BUSY_MS = 250;
/**
 * The largest file moved at open, in pages (D1960): 128 MiB of 4 KiB pages. A larger file keeps its layout and works
 * as before (one log line an open); `bun packages/graph/src/migrate.ts FILE` moves it with the server stopped. The
 * time a move may take is bounded by `MIGRATE_BUDGET_MS`; this cap only saves starting a copy that could not finish.
 */
export const MIGRATE_MAX_PAGES = 32_768;
/**
 * The longest a move may run at open (D1960). A router starts its children at once (`EDEN_PROCESSES`, one a core),
 * each moving its own file inside a 30 s start deadline (D172) that also covers the gate's warm-up and the persisted
 * users: with a 110 MB file a child, eight moving at once took 20.8-28 s. The copy reads the clock between tables and
 * between batches of `MIGRATE_BATCH_ROWS` rows and rolls the whole move back past this (one log line; the file works
 * as before, the next start tries again, `migrate.ts` has no budget). The VACUUM after it runs only if the move took
 * at most half of this: it measured 0.15-0.2x the move, and a skipped one is retried at a later open (`LOOSE_SHARE`).
 */
export const MIGRATE_BUDGET_MS = 3_000;
/** Rows a copy statement moves before the clock is read again (about 100 pages: 10-50 ms by load). */
const MIGRATE_BATCH_ROWS = 4_096;
/**
 * The free space a move needs, as multiples of the file plus its WAL (D1960). Measured on tmpfs with a 28.5 MB old
 * file: the move and its VACUUM used at most 1.0x more on the file's filesystem (the new tables in the WAL, then the
 * file grown by them) and 0.47x in SQLite's temp directory (VACUUM's copy of the database), 1.48x when the two are one
 * filesystem. Each requirement is about a third over the measurement, plus `ROOM_RESERVE`, so a small file never
 * takes a disk's last bytes. Short of it the file keeps its layout: a move that commits and then cannot VACUUM leaves
 * a file 1.5x the old one and the disk full, where the old file kept working. A compaction alone (a later open) needs
 * the same multiples of the file's live pages.
 */
const ROOM = { file: 1.5, temp: 1, both: 2 } as const;
const ROOM_RESERVE = 4 * 2 ** 20;
/**
 * A file whose free pages are at least this share of it (and at least `LOOSE_MIN_PAGES`) is compacted at open, when
 * its live pages are at most half `maxPages` (a capped file's moved size) and the disk has room (D1960): a move whose
 * VACUUM was skipped (the budget) or failed (the disk) is finished at a later open, once.
 */
const LOOSE_SHARE = 0.25;
const LOOSE_MIN_PAGES = 256;

export interface MigrateResult {
  /**
   * `current`: nothing to do; `migrated`: moved now; `compacted`: an earlier move's VACUUM finished now; `kept`: not
   * moved or not compacted, the file is as it was.
   */
  status: "current" | "migrated" | "compacted" | "kept";
  /** Rows moved (`migrated`). */
  rows?: number;
  /** Why it was kept (an error's message, never a row). */
  reason?: string;
}

export interface MigrateOptions {
  log?: (line: string) => void;
  /** Called with each step's name before it runs (tests stop the move there). */
  onStep?: (step: string) => void;
  maxPages?: number;
  budgetMs?: number;
  /** Bytes free to this process on the filesystem holding `dir` (tests stand in a full disk). */
  freeBytes?: (dir: string) => number;
}

/**
 * Moves a file's rowid tables to the WITHOUT ROWID layout, once (D1960). One transaction (`BEGIN IMMEDIATE`, so the
 * layout is read again under the write lock): for each rowid table a `<table>_new` WITHOUT ROWID, every row copied by
 * named columns in key order (in rowid order the new B-tree was built at random and wrote 10x the bytes), in batches
 * that read the clock (`MIGRATE_BUDGET_MS`), and counted, the old table dropped and the new one renamed; then a VACUUM
 * and a WAL truncate, each in its own try. A crash or an error at any statement before the commit rolls the whole
 * move back (WAL): the file is in one layout or the other, every row in it. Not `VACUUM INTO` a copy renamed over the
 * file: another connection open on it (a second mcp-stdio, an older process) would keep writing the old inode. Here
 * such a connection keeps reading its snapshot and re-prepares its statements on the new schema at its next step
 * (SQLite's schema check); one holding the write lock makes the move give up after `MIGRATE_BUSY_MS`. Before it
 * starts: the columns must be the map's, no index, trigger or view made outside Eden may name the tables (the drop
 * would lose it), the file must be within `maxPages`, and the disk must have room (`ROOM`). A moved file left with
 * many free pages is compacted at a later open (`LOOSE_SHARE`). Never throws: a failure is one log line and the file
 * keeps its layout. docs/research/opt-round4-graph.md has the measurements.
 */
export function migrateLayout(db: Database, options: MigrateOptions = {}): MigrateResult {
  const log = options.log ?? console.error;
  const step = options.onStep ?? (() => {});
  const maxPages = options.maxPages ?? MIGRATE_MAX_PAGES;
  const budgetMs = options.budgetMs ?? MIGRATE_BUDGET_MS;
  const free = options.freeBytes ?? freeBytesAt;
  let busy: number | undefined;
  const shortWait = () => {
    busy = pragma(db, "busy_timeout");
    db.exec(`PRAGMA busy_timeout = ${MIGRATE_BUSY_MS}`);
  };
  try {
    const old = rowidTables(db);
    if (old.length === 0) return compactLoose(db, log, step, maxPages, free, shortWait);
    for (const t of old) {
      const cols = (db.query(`PRAGMA main.table_info(${t})`).values() as [number, string][]).map((r) => r[1]);
      if (cols.join() !== COLUMNS[t].join()) return kept(log, db, `${t} has the columns ${cols.join(", ")}`);
    }
    const others = dependents(db);
    if (others) return kept(log, db, others);
    const pages = pragma(db, "main.page_count");
    if (pages > maxPages) return kept(log, db, `${pages} pages, more than the ${maxPages} moved at open`);
    const short = roomFor(db, pages * pragma(db, "main.page_size") + walBytes(db), free);
    if (short) return kept(log, db, short);
    const started = performance.now();
    // `share` below 1 leaves room for what follows the check: the commit of a large file takes 200-300 ms (the review).
    const inTime = (at: string, share = 1) => {
      const ms = performance.now() - started;
      if (ms > budgetMs * share)
        throw new Error(`over the ${budgetMs} ms a move may take at open (${Math.round(ms)} ms, ${at})`);
    };
    shortWait();
    let rows = 0;
    step("begin");
    db.exec("BEGIN IMMEDIATE");
    try {
      // Read again under the lock: another process may have moved the file since the look above.
      const moving = rowidTables(db);
      if (moving.length === 0) {
        db.exec("ROLLBACK");
        return { status: "current" };
      }
      for (const t of moving) {
        inTime(`before ${t}`);
        step(`${t}:create`);
        db.exec(`DROP TABLE IF EXISTS ${t}_new`);
        db.exec(`CREATE TABLE ${t}_new ${TABLE_SQL[t]}`);
        step(`${t}:copy`);
        const copied = copyInKeyOrder(db, t, inTime);
        // The copy read the key's index; the count reads the table itself, so an index missing rows cannot drop them.
        const held = db.query(`SELECT count(*) FROM ${t} NOT INDEXED`).values()[0]![0] as number;
        if (copied !== held) throw new Error(`${t}: copied ${copied} of ${held} rows`);
        rows += copied;
        step(`${t}:drop`);
        db.exec(`DROP TABLE ${t}`);
        step(`${t}:rename`);
        db.exec(`ALTER TABLE ${t}_new RENAME TO ${t}`);
      }
      inTime("before the commit", 0.9);
      step("commit");
      db.exec("COMMIT");
    } catch (e) {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back (a full disk can): the first error is the one logged.
      }
      throw e;
    }
    // The old tables' pages are free inside the file now, and the new tables were written past them, so the file is
    // larger than before; VACUUM writes it again at its new size (half the old file). Its own transaction: a crash,
    // a failure or a skip here leaves the moved file with free pages, which later writes reuse and a later open
    // compacts (`compactLoose`).
    let compacted = "compacted";
    const moveMs = performance.now() - started;
    if (moveMs > budgetMs / 2) {
      compacted = `not compacted (the move took ${Math.round(moveMs)} ms; a later open compacts it)`;
    } else {
      try {
        step("vacuum");
        db.exec("VACUUM");
      } catch (e) {
        compacted = `not compacted (${message(e)}; later writes reuse its free pages, a later open compacts it)`;
      }
    }
    truncateWal(db);
    const ms = Math.round(performance.now() - started);
    log(
      `eden: source map ${db.filename} moved to the WITHOUT ROWID layout (D1960): ${rows} rows, ${compacted}, ${ms} ms`,
    );
    return { status: "migrated", rows };
  } catch (e) {
    // A rolled-back move leaves its copy in the WAL (48 MB on a 121 MB file, measured): truncated here too, or it
    // stays that size for the connection's life.
    truncateWal(db);
    return kept(log, db, message(e));
  } finally {
    if (busy !== undefined) {
      try {
        db.exec(`PRAGMA busy_timeout = ${busy}`);
      } catch {
        // A broken connection: the constructor's next statement reports it.
      }
    }
  }
}

/**
 * Copies a rowid table's rows into `<t>_new` in key order, `MIGRATE_BATCH_ROWS` at a time: each batch starts past the
 * largest key copied so far (read from the new table's B-tree in SQL), and `inTime` runs between
 * batches. Returns the rows copied; the caller checks them against the table's count.
 */
function copyInKeyOrder(db: Database, t: Table, inTime: (at: string) => void): number {
  const cols = COLUMNS[t].join(", ");
  const keys = COLUMNS[t].slice(0, KEY_COLUMNS[t]);
  const key = keys.join(", ");
  const insert = `INSERT INTO ${t}_new (${cols}) SELECT ${cols} FROM ${t}`;
  const limit = `ORDER BY ${key} LIMIT ${MIGRATE_BATCH_ROWS}`;
  const first = db.prepare(`${insert} ${limit}`);
  // The last key copied is read in SQL, never round-tripped through JS: text that is not valid UTF-8 would come back
  // as U+FFFD and skip rows (the count check then kept the file at every open, the review's probe).
  const lastKey = `SELECT ${key} FROM ${t}_new ORDER BY ${keys.map((k) => `${k} DESC`).join(", ")} LIMIT 1`;
  const next = db.prepare(`${insert} WHERE (${key}) > (${lastKey}) ${limit}`);
  try {
    let copied = first.run().changes;
    let total = copied;
    while (copied === MIGRATE_BATCH_ROWS) {
      inTime(`${t}:copy`);
      copied = next.run().changes;
      total += copied;
    }
    return total;
  } finally {
    for (const s of [first, next]) s.finalize();
  }
}

/**
 * Finishes an earlier move whose VACUUM was skipped or failed (D1960), and compacts any other WITHOUT ROWID file
 * grown loose (a new file after many `forget`s): a file with no rowid table whose free pages are at least
 * `LOOSE_SHARE` of it is compacted, if its live pages are at most half `maxPages` and the disk has room.
 * Anything else is `current`, untouched; a file it cannot compact now (no room, locked, full) is `kept`, one line.
 */
function compactLoose(
  db: Database,
  log: (line: string) => void,
  step: (step: string) => void,
  maxPages: number,
  free: (dir: string) => number,
  shortWait: () => void,
): MigrateResult {
  const pages = pragma(db, "main.page_count");
  const loose = pragma(db, "main.freelist_count");
  const live = pages - loose;
  if (loose < LOOSE_MIN_PAGES || loose < pages * LOOSE_SHARE || live > maxPages / 2) return { status: "current" };
  const notCompacted = (reason: string): MigrateResult => {
    log(`eden: source map ${db.filename} is not compacted (D1960; it works as before): ${reason}`);
    return { status: "kept", reason };
  };
  const short = roomFor(db, live * pragma(db, "main.page_size") + walBytes(db), free);
  if (short) return notCompacted(short);
  const started = performance.now();
  shortWait();
  try {
    step("compact");
    db.exec("VACUUM");
  } catch (e) {
    truncateWal(db);
    return notCompacted(message(e));
  }
  truncateWal(db);
  const ms = Math.round(performance.now() - started);
  log(`eden: source map ${db.filename} compacted (D1960): ${loose} free pages of ${pages}, ${ms} ms`);
  return { status: "compacted" };
}

/**
 * Why the disk cannot take the move or compaction of `bytes` (null when it can): `ROOM`'s multiples on the file's
 * filesystem and on the one SQLite's VACUUM writes its temporary database to, summed when the two are one.
 */
function roomFor(db: Database, bytes: number, free: (dir: string) => number): string | null {
  const dir = dirname(db.filename);
  const need = (k: number) => Math.ceil(bytes * k) + ROOM_RESERVE;
  const mib = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;
  const tmp = vacuumTempDir(db);
  try {
    const here = free(dir);
    const same = tmp === null || statSync(tmp).dev === statSync(dir).dev;
    const fileNeed = need(same && tmp !== null ? ROOM.both : ROOM.file);
    if (here < fileNeed) return `${mib(here)} free beside it, short of the ${mib(fileNeed)} the move needs`;
    if (!same) {
      const there = free(tmp);
      if (there < need(ROOM.temp))
        return `${mib(there)} free in ${tmp}, short of the ${mib(need(ROOM.temp))} VACUUM needs`;
    }
    return null;
  } catch (e) {
    return `free space unknown (${message(e)})`;
  }
}

/** Free bytes for an unprivileged writer on the filesystem holding `dir`. */
function freeBytesAt(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

/**
 * Where SQLite's unix VFS puts VACUUM's temporary database (`unixTempFileDir`): `temp_store_directory`, then
 * `SQLITE_TMPDIR`, `TMPDIR`, /var/tmp, /usr/tmp, /tmp, the first that is a writable directory, else ".". Null when
 * temp storage is memory (`temp_store = 2`; this build's default, `SQLITE_TEMP_STORE=1`, is a file).
 */
function vacuumTempDir(db: Database): string | null {
  if (pragma(db, "temp_store") === 2) return null;
  let set: unknown;
  try {
    set = db.query("PRAGMA temp_store_directory").values()[0]?.[0];
  } catch {
    // A build without the deprecated pragma: the environment decides.
  }
  for (const d of [set, process.env.SQLITE_TMPDIR, process.env.TMPDIR, "/var/tmp", "/usr/tmp", "/tmp"]) {
    if (typeof d !== "string" || d === "") continue;
    try {
      if (!statSync(d).isDirectory()) continue;
      accessSync(d, fsConstants.W_OK | fsConstants.X_OK);
      return d;
    } catch {
      // Missing or not writable: SQLite tries the next.
    }
  }
  return ".";
}

/**
 * An index, trigger or view made outside Eden on the map's tables (the map makes none): the move's DROP would delete
 * an index or trigger with its table, and a view naming a table makes the rename fail. Such a file keeps its layout.
 */
function dependents(db: Database): string | null {
  const named = new RegExp(`\\b(${TABLES.join("|")})\\b`, "i");
  const rows = db
    .query("SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('index', 'trigger', 'view')")
    .values() as [string, string, string, string | null][];
  const found = rows
    .filter(([type, , table, sql]) => {
      if (sql === null) return false; // a primary key's automatic index
      return (TABLES as readonly string[]).includes(table.toLowerCase()) || (type !== "index" && named.test(sql));
    })
    .map(([type, name]) => `${type} ${name}`);
  if (found.length === 0) return null;
  return `${found.join(", ")} not made by Eden names its tables, and the move would drop or break it`;
}

/** Truncates the WAL if no reader holds it (the move or VACUUM grew it to the rewrite's size); else it is reused. */
function truncateWal(db: Database): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // A reader holds it or the disk refused: later checkpoints reuse it from the start.
  }
}

function walBytes(db: Database): number {
  try {
    return statSync(`${db.filename}-wal`).size;
  } catch {
    return 0;
  }
}

function pragma(db: Database, name: string): number {
  return db.query(`PRAGMA ${name}`).values()[0]![0] as number;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The map's tables that still have a rowid (`PRAGMA table_list`'s `wr` is 0). */
function rowidTables(db: Database): Table[] {
  const rows = db.query("PRAGMA main.table_list").values() as [string, string, string, number, number][];
  const wr = new Map(rows.map((r) => [r[1], r[4]]));
  return TABLES.filter((t) => wr.get(t) === 0);
}

function kept(log: (line: string) => void, db: Database, reason: string): MigrateResult {
  log(`eden: source map ${db.filename} keeps its rowid layout (D1960; it works as before): ${reason}`);
  return { status: "kept", reason };
}

const NONE = { shown: 0, used: 0 } as const;
/**
 * Keys plus rows each read memo holds before it is emptied whole (D1935): about 0.45 MB of heap when full (2-row keys
 * over 100 users, measured), an open map's whole cost however many users it serves (one map a server process).
 */
const MEMO_MAX = 4_096;

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

/**
 * An entity as the map keys it: trimmed, lowercased, every run of whitespace one space. ASCII with single inner
 * spaces and no control whitespace (most names) is lowercased alone (D1937: the same string, without the trim's and
 * the replace's passes); anything else takes `normalizeEntitySlow`, the definition (`source-map-fast.test.ts` fuzzes
 * the two).
 */
export function normalizeEntity(e: string): string {
  const n = e.length;
  let upper = false;
  let space = true;
  for (let i = 0; i < n; i++) {
    const c = e.charCodeAt(i);
    if (c === 32) {
      if (space) return normalizeEntitySlow(e);
      space = true;
    } else if (c >= 0x80 || (c >= 9 && c <= 13)) return normalizeEntitySlow(e);
    else {
      space = false;
      if (c >= 65 && c <= 90) upper = true;
    }
  }
  if (space && n > 0) return normalizeEntitySlow(e);
  return upper ? e.toLowerCase() : e;
}

/** `normalizeEntity`'s definition (the whole function before D1937). */
export function normalizeEntitySlow(e: string): string {
  return e.trim().toLowerCase().replace(/\s+/g, " ");
}
