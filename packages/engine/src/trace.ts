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
   * - answer: answered an ask.
   */
  decision: "skipped" | "repeat" | "silent" | "fast" | "sources" | "model" | "answer";
  reason: string;
  latencyMs: number;
  sourceCalls: number;
  modelCalls: number;
  costUsd: number;
  itemIds: string[];
  /**
   * With the query planner on: per connector searched, the shapes it sent and its calls. Shape names and counts only,
   * never the query (D19).
   */
  plans?: { sourceId: string; shapes: string[]; calls: number }[];
}

export type TraceSink = (trace: Trace) => void;
