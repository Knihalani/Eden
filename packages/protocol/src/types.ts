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
   * `draft`: the user is still typing it (a chat box's text before it is sent). Never a request: Eden ignores it. The
   * sent message follows as usual.
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
  /**
   * How each source the ask chose to search fared (D127), in the order it was chosen. `status` is one of "ok",
   * "cached" or "stale" (answered from the fan-out's live or held result), "local" (answered from the user's synced
   * index), or, not answered: "error", "timeout", "open" (circuit open), "busy", "limited" (Eden's own rate limit
   * skipped the call), "throttled" (the connector answered 429, D212), "searching" (its poll or live search was
   * still running when the ask answered; what it finds that fits follows as a later packet, D430) or "unsearched"
   * (the engine's `sourceYield`, D505, D603: a copy the user's item cap cut was answered from what is held and not
   * searched live, the request having no name or rare word that points to the source). A source the
   * router did not choose is not listed. An empty answer is an all-clear only when every listed source answered;
   * otherwise the answer text names the sources that did not (the text carries it too, since an MCP caller sees only
   * the text).
   * Optional and additive: absent from older servers and from the engine's own push readings.
   */
  sources?: { sourceId: string; status: string }[];
}

/** What `observe` returns: context to deliver now, if any was ready within the deadline. */
export interface ObserveResult {
  injection: Injection | null;
  /** True when slower work (live source search, model judgement) continues and may queue a later injection. */
  pending: boolean;
}

/**
 * One decision Eden made in a session, as `POST /v1/explain` returns it (D277): why it spoke or stayed silent, with no
 * content. `decision` is the engine's trace decision ("skipped", "repeat", "silent", "fast", "sources", "model",
 * "answer", "reader-push", "reader-late", "check-late", "verify"); `reason` its fixed words or a cue id (a hash,
 * never text); `why` a plain sentence; `itemIds` the items it delivered or cited (ids only). Counts and cost are this
 * decision's own.
 */
export interface ExplainedDecision {
  turn: number;
  event: string;
  decision: string;
  reason: string;
  why: string;
  latencyMs: number;
  sourceCalls: number;
  modelCalls: number;
  costUsd: number;
  itemIds: string[];
}

/** `POST /v1/explain`: the session's last decisions, oldest first (at most 32; none once the session ended). */
export interface ExplainResponse {
  decisions: ExplainedDecision[];
}

/**
 * What the partner says about an action the agent is about to take (`checkAction`, the action firewall): the agent's
 * tool call is checked, before it runs, against what the partner holds. `proceed` when nothing held bears on it;
 * `finding` with the held context that does, as data (an `Injection` in the usual envelope). What the integration does
 * with a finding (hold the call, show it to the agent or the user) is its own choice.
 */
export interface ActionCheck {
  verdict: "proceed" | "finding";
  finding: Injection | null;
  /** Short machine-readable reason, for logs and evals ("off", "clear", "conflict", "repeat"). */
  reason: string;
  latencyMs: number;
}

/**
 * Why a change notification (`/v1/sources/changed`) acted on nothing: push sync is off on the server (`syncPush` or
 * `sync`), the source has no sync state for the user (an unknown user or source id, a search-only source, or one no
 * lookup has synced yet), or it is synced but not declared `notifies`. Held search pages for the source are dropped
 * either way while push is on.
 */
export type SourceChangedReason = "push-off" | "not-synced" | "not-notifying";

/** What a change notification did: `synced` when the source's copy will be polled at its next use; else why not. */
export interface SourceChangedResult {
  synced: boolean;
  /** Set only when `synced` is false. Optional and additive: absent from older servers. */
  reason?: SourceChangedReason;
}

/** How a later turn showed whether the agent used an injection. Feeds source learning. */
export interface Feedback extends Scope {
  sessionId: string;
  injectionId: string;
  used: boolean;
  /** "auto" when inferred from later events, "explicit" when the integration reported it. */
  how: "auto" | "explicit";
}
