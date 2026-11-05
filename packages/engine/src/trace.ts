/** One record per decision the engine makes: what evals score and what the operator's logs show. No content. */
export interface Trace {
  sessionId: string;
  turn: number;
  event: string;
  /**
   * - skipped: the event kind or text carries no information need (chatter, an agent message);
   * - repeat: the cue was looked up recently;
   * - silent: looked, found nothing worth delivering;
   * - fast: delivered from the cache with no source call and no model;
   * - sources: delivered after a live source search, no model;
   * - model: delivered after the model judged the candidates;
   * - answer: answered an ask;
   * - reader-push: `readerPush` read a user's request with the ask-time reader (its cost, and what it queued);
   * - reader-late: a reader call an explicit ask started landed after the ask stopped waiting (`askReaderWaitMs`):
   *   its cost and its one model call, which the ask's own "answer" trace leaves out. Emitted even after the session
   *   closed. No items.
   */
  /** "verify": `verifyDelivery`'s re-reads before a delivery, traced apart so traces sum to what the connectors got. */
  decision:
    | "skipped"
    | "repeat"
    | "silent"
    | "fast"
    | "sources"
    | "model"
    | "answer"
    | "reader-push"
    | "reader-late"
    | "verify";
  reason: string;
  latencyMs: number;
  /**
   * Calls the connectors received for this decision: a search answered by the fan-out's cache, one that joined another
   * lookup's call in flight (a "reader-push" lookup and the slow path search the same words at once), or one a guard
   * refused is not counted; a planner's cascade counts each call it sent. Fetches (refreshes) and on-demand sync
   * listings are included. Summed over a task's traces, with `anticipateCalls`, it is the task's request-time calls.
   */
  sourceCalls: number;
  modelCalls: number;
  costUsd: number;
  /**
   * With `askReader`: the part of `modelCalls` and `costUsd` that is the ask-time reader's call (on an "answer", a
   * "reader-push" or a "reader-late" trace), so a harness that also meters the reader's model itself does not count
   * it twice.
   */
  readerCalls?: number;
  readerCostUsd?: number;
  itemIds: string[];
  /**
   * With the query planner on: per connector searched, the shapes it sent, its calls and how many items came back.
   * Shape names and counts only, never the query (D19).
   */
  plans?: { sourceId: string; shapes: string[]; calls: number; found: number }[];
  /**
   * With the background sync on (D57): the sources this lookup answered from the user's local index, at no call, and
   * the listing calls of its on-demand polls (counted in `sourceCalls`).
   */
  localSources?: number;
  syncCalls?: number;
  /**
   * With `anticipate`: source calls an event's background prefetch made (a "skipped" trace with reason "anticipate";
   * they are not `sourceCalls`, which count a lookup's own), and, on a delivery, the delivered item ids the session's
   * anticipation had fetched or held ready before the request (ids only, as `itemIds`).
   */
  anticipateCalls?: number;
  prefetched?: string[];
}

export type TraceSink = (trace: Trace) => void;

/**
 * What the query planner found in shadow mode for one connector of one lookup, beside what was served. Shapes, counts
 * and item ids only, like a trace; never query text or item content (D19). `status`: "ok", "limited" (no rate token
 * was left for it), "error".
 */
export interface ShadowRecord {
  sessionId: string;
  turn: number;
  sourceId: string;
  status: "ok" | "limited" | "error";
  shapes: string[];
  calls: number;
  itemIds: string[];
  servedItemIds: string[];
}

export type ShadowSink = (record: ShadowRecord) => void;
