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

export interface Source {
  /** Unique within a user's set: "gmail", "notion", "crm". */
  readonly id: string;
  /** "mcp", "static", "http". */
  readonly kind: string;
  /** What the source holds, in one sentence. Seeds routing before anything is learned. */
  readonly description: string;
  /** Whether a query with a `window` and no words lists what starts in it (a calendar), D44. */
  readonly listsByTime?: boolean;
  search(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]>;
  /** One item by its source ref, for refreshing a cached item. */
  fetch?(ref: string, scope: Scope, signal: AbortSignal): Promise<ContextItem | null>;
  /**
   * One page of everything the source holds for the user, most recently updated first, from `cursor` (undefined: the
   * first page), at most `limit` items: what a background sync reads into a local index (D56). Read-only like search.
   */
  list?(scope: Scope, cursor: string | undefined, limit: number, signal: AbortSignal): Promise<ListPage>;
  close?(): Promise<void>;
}

/** The sources one user's partner may read. Resolved per user, since each user connects their own accounts. */
export type SourceResolver = (scope: Scope) => Promise<Source[]>;
