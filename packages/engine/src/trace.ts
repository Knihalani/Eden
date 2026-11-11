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
    | "check-late"
    | "verify";
  reason: string;
  latencyMs: number;
  /**
   * Calls the connectors received for this decision: a search answered by the fan-out's cache, one that joined another
   * lookup's call in flight (a "reader-push" lookup and the slow path search the same words at once), or one a guard
   * refused is not counted; a planner's cascade counts each call it sent. Fetches (refreshes) and on-demand sync
   * listings are included. Summed over a task's traces, it is the task's request-time calls.
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
  /**
   * With `pushCheck` (D500): the part of `modelCalls` and `costUsd` that is the push check's call, so a harness that
   * meters the check's model itself does not count it twice.
   */
  checkCalls?: number;
  checkCostUsd?: number;
  /** `pushCheckLocal` (D894): the check was a student's scores, not a model call (not counted in `modelCalls`). */
  checkLocal?: boolean;
  /** On a "reader-push" trace: the push handed out candidates (`pushCandidates`, D237), not a reading. */
  candidates?: boolean;
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
}

export type TraceSink = (trace: Trace) => void;

/** Every decision a trace can carry, for readers of a log (trace-report, digest) to check a line against. */
export const TRACE_DECISIONS: readonly Trace["decision"][] = [
  "skipped",
  "repeat",
  "silent",
  "fast",
  "sources",
  "model",
  "answer",
  "reader-push",
  "reader-late",
  "check-late",
  "verify",
];

/**
 * Every reason a "silent" trace gives (fixed words, `partner.ts`). Readers of a log print only these: a line that is
 * not the engine's (a log is often stdout and stderr together) must not put its words in a report (audit A11).
 */
export const SILENT_REASONS: readonly string[] = [
  "slow path busy",
  "served",
  "no candidates",
  "judge: untied",
  "no model",
  "no model budget",
  "model error",
  "model truncated",
  "model: none",
  "error",
];

/**
 * Whether the agent used one injection (D293), when that becomes known: inferred from a later agent message or tool
 * call repeating its distinctive terms (D18), counted unused when its usage window passed (`expired`) or its session
 * ended (`ended`), or reported by the integration (`explicit`, D13; a correction of an earlier outcome too). Ids, a
 * flag and the connector ids only, like a trace (D56): never the injection's or the event's text. An injection id is
 * random (`newId`), not derived from content.
 */
export interface UsageRecord {
  sessionId: string;
  injectionId: string;
  used: boolean;
  how: "inferred" | "expired" | "ended" | "explicit";
  /** The connectors whose items the injection carried (configuration ids, as in a trace's item ids). */
  sourceIds: string[];
}

export type UsageSink = (record: UsageRecord) => void;

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

/**
 * One plain sentence on why a trace's decision was made (D277), for `explain` and an operator's logs. Built from the
 * decision, its fixed reason words and the counts: no content (a cue id is a hash, never the text).
 */
export function explainTrace(t: Trace): string {
  const n = t.itemIds.length;
  const items = `${n} item${n === 1 ? "" : "s"}`;
  switch (t.decision) {
    case "skipped":
      if (t.reason === "sync poll behind") {
        return "A background sync poll that an earlier lookup did not wait for finished; its source calls are counted here.";
      }
      return `Not looked up: this ${t.reason} event carries no information need (chatter, an agent message, a result with nothing new).`;
    case "repeat":
      return "Not looked up again: the same cue was looked up a few turns ago (cueCooldownTurns).";
    case "fast":
      if (t.reason.startsWith("action-")) {
        return `The action firewall found ${items} bearing on the tool call about to run (no model call).`;
      }
      return `Spoke from the user's cached items with no source call: ${items} matched surely enough.`;
    case "sources":
      if (t.reason.startsWith("updated:")) {
        return `Sent a newer version of ${items} already shown in this session: the source changed them.`;
      }
      if (t.reason.startsWith("grounded-")) {
        return `Spoke after a source search: ${items} grounded by the request's people, days or a conflict (no model).`;
      }
      if (t.reason.startsWith("fallback")) {
        return `Spoke after a source search: the single best match (${items}) passed the no-model fallback bar.`;
      }
      return `Spoke after a source search: ${items} passed the no-model confidence bar.`;
    case "model":
      return `Spoke after a model judged the candidates: ${items}.`;
    case "answer":
      return `Answered an ask_context question with ${items}${t.modelCalls > 0 ? " (with a model call)" : " (no model call)"}.`;
    case "reader-push":
      if (t.candidates) {
        return n > 0
          ? `The request acts: handed the agent ${items} as candidates to check against it, with no model call (D237).`
          : "The request acts, but nothing found looked able to constrain it (no constraint wording or card), so no candidates were sent.";
      }
      if (t.readerCalls === undefined) {
        return "The request acts, but the reader made no reading (nothing to read, gated, over budget or unavailable), so nothing was pushed.";
      }
      return n > 0
        ? `The request acts: the reader read it and flagged ${items}.`
        : "The request acts: the reader read it and flagged nothing that bears on it.";
    case "reader-late":
      return "A reader call an ask had stopped waiting for finished late; its cost is counted here.";
    case "check-late":
      return "A push check the push had stopped waiting for (or whose session closed) finished; its cost is counted here.";
    case "verify":
      return `Re-read ${items} whose source reported changes, before delivering them.`;
    case "silent":
      switch (t.reason) {
        case "slow path busy":
          return "Silent: an earlier lookup in this session was still running, so this event was not looked up.";
        case "no candidates":
          return "Silent: looked in the sources and found nothing that matched.";
        case "served":
          return "Silent: the request was already answered by an earlier delivery and nothing new and sure turned up.";
        case "no model":
          return "Silent: found candidates, but none passed the no-model bar (score, entities, grounding), and no judge is wired: Eden stays quiet rather than guess (D3).";
        case "no model budget":
          return "Silent: found candidates, none passed the no-model bar, and the model budget was spent.";
        case "model: none":
          return "Silent: the model judged the candidates and picked none.";
        case "judge: untied":
          return "Silent: the candidates were barely tied to the request, so no judge was asked.";
        default:
          return `Silent: looked and delivered nothing (${t.reason}).`;
      }
  }
}
