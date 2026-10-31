/**
 * The wire types every package shares. The partner sits beside a personal or proactive agent: it observes what
 * happens in a session (`AgentEvent`), answers the agent's questions (`AskRequest`) and, on its own, puts context in
 * front of the agent (`Injection`). Context comes from read-only sources (`ContextItem`).
 *
 * Identity has three levels: a tenant is our customer (the company whose agent integrates us), a user is the
 * tenant's end user (whose mail, calendar and documents the sources read), and a session is one conversation or
 * task run of the agent. Nothing ever crosses a user boundary.
 */

/** Who an event, item or injection belongs to. */
export interface Scope {
  tenantId: string;
  userId: string;
}

interface EventBase extends Scope {
  sessionId: string;
  /** Epoch milliseconds. */
  at: number;
}

/** Something that happened in the agent's session, as the integration reports it. */
export type AgentEvent =
  | (EventBase & { kind: "session_start"; agent?: string; metadata?: Record<string, string> })
  /**
   * `draft`: the user is still typing it (a chat box's text before it is sent). Never a request: Eden only reads it
   * ahead for what the agent will need (`anticipate`), and ignores it otherwise. The sent message follows as usual.
   * Before this field existed the server stripped unknown fields, so a client that already sent `draft: true` had its
   * draft handled as a sent message; now it is dropped whatever the flags (D60, D63).
   */
  | (EventBase & { kind: "user_message"; text: string; draft?: boolean })
  | (EventBase & { kind: "agent_message"; text: string })
  | (EventBase & { kind: "tool_call"; tool: string; input: unknown })
  | (EventBase & { kind: "tool_result"; tool: string; output: string; isError?: boolean })
  /** Something outside the conversation the agent is acting on: a new email, a calendar change, a webhook. */
  | (EventBase & { kind: "external"; source: string; text: string })
  | (EventBase & { kind: "session_end" });

export type AgentEventKind = AgentEvent["kind"];

/** One unit of context a source returned. `id` is stable: `${sourceId}:${ref}`. */
export interface ContextItem {
  id: string;
  sourceId: string;
  /** The source's own identifier for the item (a message id, a page id, a URL). */
  ref: string;
  title: string;
  text: string;
  url?: string;
  /** Epoch milliseconds the item last changed at its source, when the source says. */
  updatedAt?: number;
  meta?: Record<string, string>;
}

/** Where a piece of delivered context came from. */
export interface Citation {
  itemId: string;
  sourceId: string;
  title: string;
  url?: string;
}

/** Why the partner spoke: on its own initiative, or because the agent asked. */
export type InjectionMode = "proactive" | "answer";

/** Context the partner hands the agent. `text` is ready to place in the agent's prompt. */
export interface Injection extends Scope {
  id: string;
  sessionId: string;
  mode: InjectionMode;
  text: string;
  citations: Citation[];
  /** Short machine-readable reason, for logs and evals ("entity:acme-renewal", "ask"). */
  reason: string;
  score: number;
  createdAt: number;
}

export interface AskRequest extends Scope {
  sessionId: string;
  question: string;
  /** Upper bound on items the answer may cite. */
  maxItems?: number;
}

export interface AskResponse {
  answer: string;
  citations: Citation[];
  /** Whether a model call was made. The cheap path answers with retrieved items alone. */
  usedModel: boolean;
  costUsd: number;
  latencyMs: number;
}

/** What `observe` returns: context to deliver now, if any was ready within the deadline. */
export interface ObserveResult {
  injection: Injection | null;
  /** True when slower work (live source search, model judgement) continues and may queue a later injection. */
  pending: boolean;
}

/** How a later turn showed whether the agent used an injection. Feeds source learning. */
export interface Feedback extends Scope {
  sessionId: string;
  injectionId: string;
  used: boolean;
  /** "auto" when inferred from later events, "explicit" when the integration reported it. */
  how: "auto" | "explicit";
}
