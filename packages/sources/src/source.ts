/**
 * A source is anything the partner can read context from: an MCP server's read tools, a connector, a static set.
 * Sources are read-only by contract. The partner never calls a tool that changes the outside world; `McpSource`
 * enforces that against the server's own tool annotations.
 */
import type { ContextItem, Scope } from "@eden/protocol";

export interface SearchQuery {
  scope: Scope;
  /** Free text: the cue the partner built from the session, or the agent's question. */
  text: string;
  /** Entities the cue named (people, projects, ids), when known. A source may search on them directly. */
  entities: string[];
  limit: number;
  /**
   * The days the request names (D44), as YYYY-MM-DD, `end` exclusive. A source that can list by time (a calendar)
   * returns what falls in it even when no word matches; others may ignore it.
   */
  window?: { start: string; end: string; offsetMinutes?: number };
}

/**
 * One page of a source's listing (`Source.list`): its items, most recently updated first, and the cursor of the next
 * page (null on the last). A cursor is the source's own and opaque: it is only ever handed back to the same source.
 */
export interface ListPage {
  items: ContextItem[];
  next: string | null;
}

/**
 * What changed in a source since a cursor (`Source.changes`): a Gmail history list from a `historyId`, a Graph or
 * Drive delta from its token, a Calendar list with a `syncToken`, a Salesforce change-data-capture replay.
 */
export interface ChangePage {
  /** Items created or changed since the cursor, as `list` returns them. */
  items: ContextItem[];
  /** Refs (`ContextItem.ref`) of items deleted since the cursor. */
  removed: string[];
  /** The cursor to hand back next time. */
  next: string;
  /** More changes wait behind this page: call again with `next`. */
  more?: boolean;
}

export interface Source {
  /** Unique within a user's set: "gmail", "notion", "crm". */
  readonly id: string;
  /** "mcp", "static", "http". */
  readonly kind: string;
  /** What the source holds, in one sentence. Seeds routing before anything is learned. */
  readonly description: string;
  /** Whether a query with a `window` and no words lists what starts in it (a calendar), D44. */
  readonly listsByTime?: boolean;
  /**
   * Whether the integrator forwards this source's change notifications to Eden (`ContextPartner.sourceChanged`, or
   * the changed items themselves with `sourceItems`): a Gmail watch, a Calendar or Drive channel, Slack's Events API,
   * a Graph subscription, a HubSpot webhook, a connector platform's trigger. With the engine's `syncPush`, a synced
   * source that notifies is polled when told it changed (and at most `syncPushMaxStaleMs`, 24 h, apart), not
   * whenever its learned change rate says it may have.
   */
  readonly notifies?: boolean;
  search(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]>;
  /**
   * Whether `fetch` returning null means the source no longer has the item (deleted), rather than "could not say":
   * true for sources that hold their items (static, the sim). Absent (an MCP tool, whose reply may lack the row for
   * other reasons): a null fetch proves nothing, and a freshness check keeps the item (labelled with its age).
   */
  readonly fetchReportsGone?: boolean;
  /**
   * Whether `fetch` can find an item by its ref at all (an MCP connector with a get tool wired; static and sim
   * sources). An MCP source without a fetch tool still has a `fetch` that answers null to everything, with no call.
   * Absent: read as `fetchReportsGone`. Only a source that can confirm an item by ref may be swept less often (D356).
   */
  readonly fetchesById?: boolean;
  /** One item by its source ref, for refreshing a cached item. */
  fetch?(ref: string, scope: Scope, signal: AbortSignal): Promise<ContextItem | null>;
  /**
   * One page of everything the source holds for the user, most recently updated first, from `cursor` (undefined: the
   * first page), `limit` items as a rule: what a background sync reads into a local index (D57). Read-only like search.
   * A source whose next cursor is the server's own may return more (its whole page): rows cut from it would be skipped.
   */
  list?(scope: Scope, cursor: string | undefined, limit: number, signal: AbortSignal): Promise<ListPage>;
  /**
   * What changed since `cursor` (D476): every item created or changed and every ref deleted, in one read-only call,
   * whatever their place in the listing. With no cursor: no changes, and a cursor for "now" (asked for before the
   * first listing, so nothing falls between the two). Null: the cursor is no longer valid (a Gmail `historyId` older
   * than its history, a 410 on a sync token); the caller starts over from a listing. A sync that has this reads a
   * source's changes with one call and needs no re-listing to notice deletions.
   */
  changes?(scope: Scope, cursor: string | undefined, signal: AbortSignal): Promise<ChangePage | null>;
  close?(): Promise<void>;
}

/** The sources one user's partner may read. Resolved per user, since each user connects their own accounts. */
export type SourceResolver = (scope: Scope) => Promise<Source[]>;

/**
 * A fetch the source answered with an error result (an MCP tool's `isError`: a 5xx, a quota message, often "not
 * found"), thrown by `fetch` rather than returned as null (A8, D298): it says nothing about the item, as a null from
 * a source without `fetchReportsGone` does, but unlike a reply that simply lacks the record it may be transient, so
 * Eden never holds it as the item's state. Not a failure of the source's: `SourceFanout` settles it as answered.
 */
export class FetchErrorResult extends Error {
  override readonly name = "FetchErrorResult";
}
