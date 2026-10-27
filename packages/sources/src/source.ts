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
}

export interface Source {
  /** Unique within a user's set: "gmail", "notion", "crm". */
  readonly id: string;
  /** "mcp", "static", "http". */
  readonly kind: string;
  /** What the source holds, in one sentence. Seeds routing before anything is learned. */
  readonly description: string;
  search(query: SearchQuery, signal: AbortSignal): Promise<ContextItem[]>;
  /** One item by its source ref, for refreshing a cached item. */
  fetch?(ref: string, scope: Scope, signal: AbortSignal): Promise<ContextItem | null>;
  close?(): Promise<void>;
}

/** The sources one user's partner may read. Resolved per user, since each user connects their own accounts. */
export type SourceResolver = (scope: Scope) => Promise<Source[]>;
