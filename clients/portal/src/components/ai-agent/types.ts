/**
 * AI Agent component types — messages, sessions, citations, action cards.
 */

import type { AiContextItem } from "@/lib/context-model";
import type { CitationTarget } from "@/lib/citation-href";

// ── Messages ─────────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ContentPart {
  type: "text" | "citation" | "tool_call" | "action_card";
  text?: string;
  citation?: CitationTarget;
  toolCall?: ToolCall;
  actionCard?: ActionCard;
}

export interface AiMessage {
  message_id: string;
  role: MessageRole;
  /** Parsed content — may be a plain string (legacy) or structured parts. */
  content: string | ContentPart[];
  created_at?: string | null;
  /** Whether this message is still being streamed. */
  streaming?: boolean;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface AiSession {
  session_id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
  archived: boolean;
}

// ── Streaming SSE events ───────────────────────────────────────────────────────

export interface SseTextDelta {
  event: "text_delta";
  data: { delta: string; session_id?: string; message_id?: string };
}

export interface SseCitation {
  event: "citation";
  data: CitationTarget & { session_id?: string };
}

export interface SseToolCall {
  event: "tool_call";
  data: ToolCall & { session_id?: string };
}

export interface SseSessionId {
  event: "session_id";
  data: { session_id: string };
}

export interface SseDone {
  event: "done";
  data: { session_id?: string };
}

export interface SseError {
  event: "error";
  data: { detail: string };
}

export type SseEvent =
  | SseTextDelta
  | SseCitation
  | SseToolCall
  | SseSessionId
  | SseDone
  | SseError;

// ── Tool calls / action cards ─────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  status?: "running" | "done" | "error";
}

export type ActionCardType = "explain" | "propose_fix" | "open_plan" | "open_pr";

export interface ActionCard {
  id: string;
  type: ActionCardType;
  title: string;
  body?: string;
  evidence?: CitationTarget[];
  /** Navigate href when user confirms the action. */
  confirmHref?: string;
  /** Plan id for navigate-only plan action. */
  planId?: string;
  /** Artifact id for PR action. */
  artifactId?: string;
  confirmed?: boolean;
}

// ── Provider state ────────────────────────────────────────────────────────────

export interface AiSessionState {
  /** Whether the AI bubble/panel is open. */
  open: boolean;
  /** Active session id (stable across bubble ↔ /agent). */
  sessionId: string | null;
  /** Attached context items. */
  context: AiContextItem[];
  /** Composer draft (not auto-sent). */
  draft: string;
  /** Whether the stream is currently active. */
  streaming: boolean;
  /** In-flight abort controller. */
  abortController: AbortController | null;
}
