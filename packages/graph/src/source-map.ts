/**
 * The source map: the first layer of the knowledge graph. It records, per user, which sources have mentioned which
 * entities (people, companies, projects, ids), and how useful each source has proven in each situation. Routing
 * reads both, so the partner asks the two sources likely to know instead of all twelve.
 *
 * It holds no content: entity names, source ids, item refs and counts. Content stays at the source or in the
 * short-lived item cache. Everything is partitioned by scope key (tenant/user); no query crosses it.
 *
 * Statements go through `db.query`, which caches the prepared statement (re-preparing per call was 5% of end-to-end
 * CPU; packages/engine/bench/pipeline.bench.ts).
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
}

export class SourceMap {
  private readonly db: Database;

  private readonly explore: boolean;
  private readonly rng: Xoshiro128;

  constructor(path = ":memory:", options: SourceMapOptions = {}) {
    this.explore = options.explore ?? true;
    this.rng = new Xoshiro128(options.seed ?? (Math.random() * 2 ** 32) >>> 0);
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
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
    `);
  }

  /**
   * Records that `sourceId` returned an item mentioning these entities. The caller passes typed entities only
   * (names, handles, ids): never quoted phrases, URLs or item refs, which can carry content.
   */
  recordMentions(scope: Scope, sourceId: string, entities: string[], now = Date.now()): void {
    this.recordMentionsMany(scope, [{ sourceId, entities }], now);
  }

  /**
   * As `recordMentions` for many items in one transaction: a lookup's results are recorded together (one transaction
   * per item cost ~43 µs each; packages/engine/bench/pipeline.bench.ts).
   */
  recordMentionsMany(scope: Scope, rows: { sourceId: string; entities: string[] }[], now = Date.now()): void {
    const upsert = this.db.query(`
      INSERT INTO mention (scope, entity, source_id, count, last_seen) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (scope, entity, source_id) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen
    `);
    const key = scopeKey(scope);
    this.db.transaction(() => {
      for (const row of rows) {
        for (const e of new Set(row.entities.map(normalizeEntity))) if (e) upsert.run(key, e, row.sourceId, now);
      }
    })();
  }

  /** Records whether an injection citing `sourceId` was used, in this situation. */
  recordOutcome(scope: Scope, situation: string, sourceId: string, used: boolean): void {
    this.db
      .query(
        `INSERT INTO utility (scope, situation, source_id, shown, used) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (scope, situation, source_id) DO UPDATE SET shown = shown + 1, used = used + excluded.used`,
      )
      .run(scopeKey(scope), situation, sourceId, used ? 1 : 0);
  }

  /** Corrects an outcome recorded earlier (explicit feedback overriding an inferred one). Counts never go negative. */
  correctOutcome(scope: Scope, situation: string, sourceId: string, used: boolean): void {
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
    const row = this.db
      .query("SELECT shown, used FROM utility WHERE scope = ? AND situation = ? AND source_id = ?")
      .get(scopeKey(scope), situation, sourceId) as { shown: number; used: number } | null;
    return { shown: row?.shown ?? 0, used: row?.used ?? 0 };
  }

  /** Which sources have mentioned an entity, most often first. */
  sourcesFor(scope: Scope, entity: string): { sourceId: string; count: number }[] {
    return this.db
      .query("SELECT source_id AS sourceId, count FROM mention WHERE scope = ? AND entity = ? ORDER BY count DESC")
      .all(scopeKey(scope), normalizeEntity(entity)) as { sourceId: string; count: number }[];
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
    return request.sourceIds
      .map((sourceId) => {
        const entityHits = hits.get(sourceId) ?? 0;
        const { shown, used } = this.outcomes(request.scope, request.situation, sourceId);
        const utility = (used + 1) / (shown + 2);
        const sampled = this.explore ? this.rng.beta(used + 1, shown - used + 1) : utility;
        return { sourceId, entityHits, utility, sampled, score: entityHits + 2 * sampled };
      })
      .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
      .slice(0, request.limit);
  }

  /** Deletes everything held for a user (account deletion, connector revocation). */
  forget(scope: Scope, sourceId?: string): void {
    const key = scopeKey(scope);
    for (const table of ["mention", "utility"]) {
      if (sourceId) this.db.query(`DELETE FROM ${table} WHERE scope = ? AND source_id = ?`).run(key, sourceId);
      else this.db.query(`DELETE FROM ${table} WHERE scope = ?`).run(key);
    }
  }

  close(): void {
    this.db.close();
  }
}

export function normalizeEntity(e: string): string {
  return e.trim().toLowerCase().replace(/\s+/g, " ");
}
