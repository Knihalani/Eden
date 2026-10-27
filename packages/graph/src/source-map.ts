/**
 * The source map: the first layer of the knowledge graph. It records, per user, which sources have mentioned which
 * entities (people, companies, projects, ids), and how useful each source has proven in each situation. Routing
 * reads both, so the partner asks the two sources likely to know instead of all twelve.
 *
 * It holds no content: entity names, source ids, item refs and counts. Content stays at the source or in the
 * short-lived item cache. Everything is partitioned by scope key (tenant/user); no query crosses it.
 *
 * Learning is a Beta-Bernoulli estimate per (user, situation, source): `shown` counts injections that cited the
 * source, `used` those the agent then used. The mean (used+1)/(shown+2) starts at 0.5 and moves with evidence.
 */
import { Database } from "bun:sqlite";
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
  /** Why it ranked: entity hits and the learned usefulness. */
  entityHits: number;
  utility: number;
}

export class SourceMap {
  private readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mention (
        scope TEXT NOT NULL, entity TEXT NOT NULL, source_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, last_ref TEXT, last_seen INTEGER NOT NULL,
        PRIMARY KEY (scope, entity, source_id)
      );
      CREATE TABLE IF NOT EXISTS utility (
        scope TEXT NOT NULL, situation TEXT NOT NULL, source_id TEXT NOT NULL,
        shown INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, situation, source_id)
      );
    `);
  }

  /** Records that `sourceId` returned an item mentioning these entities. */
  recordMentions(scope: Scope, sourceId: string, ref: string, entities: string[], now = Date.now()): void {
    const upsert = this.db.prepare(`
      INSERT INTO mention (scope, entity, source_id, count, last_ref, last_seen) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT (scope, entity, source_id) DO UPDATE SET
        count = count + 1, last_ref = excluded.last_ref, last_seen = excluded.last_seen
    `);
    const key = scopeKey(scope);
    this.db.transaction(() => {
      for (const e of new Set(entities.map(normalizeEntity))) if (e) upsert.run(key, e, sourceId, ref, now);
    })();
  }

  /** Records whether an injection citing `sourceId` was used, in this situation. */
  recordOutcome(scope: Scope, situation: string, sourceId: string, used: boolean): void {
    this.db
      .prepare(
        `INSERT INTO utility (scope, situation, source_id, shown, used) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (scope, situation, source_id) DO UPDATE SET shown = shown + 1, used = used + excluded.used`,
      )
      .run(scopeKey(scope), situation, sourceId, used ? 1 : 0);
  }

  /** The learned usefulness of a source in a situation: the Beta(1,1) posterior mean. */
  utility(scope: Scope, situation: string, sourceId: string): number {
    const row = this.db
      .prepare("SELECT shown, used FROM utility WHERE scope = ? AND situation = ? AND source_id = ?")
      .get(scopeKey(scope), situation, sourceId) as { shown: number; used: number } | null;
    return ((row?.used ?? 0) + 1) / ((row?.shown ?? 0) + 2);
  }

  /** Which sources have mentioned an entity, most often first. */
  sourcesFor(scope: Scope, entity: string): { sourceId: string; count: number }[] {
    return this.db
      .prepare("SELECT source_id AS sourceId, count FROM mention WHERE scope = ? AND entity = ? ORDER BY count DESC")
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
        const utility = this.utility(request.scope, request.situation, sourceId);
        return { sourceId, entityHits, utility, score: entityHits + 2 * utility };
      })
      .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
      .slice(0, request.limit);
  }

  /** Deletes everything held for a user (account deletion, connector revocation). */
  forget(scope: Scope, sourceId?: string): void {
    const key = scopeKey(scope);
    for (const table of ["mention", "utility"]) {
      if (sourceId) this.db.prepare(`DELETE FROM ${table} WHERE scope = ? AND source_id = ?`).run(key, sourceId);
      else this.db.prepare(`DELETE FROM ${table} WHERE scope = ?`).run(key);
    }
  }

  close(): void {
    this.db.close();
  }
}

export function normalizeEntity(e: string): string {
  return e.trim().toLowerCase().replace(/\s+/g, " ");
}
