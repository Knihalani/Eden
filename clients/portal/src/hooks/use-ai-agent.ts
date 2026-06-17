"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { aiApi, type AiChartSpec, type AiCitation, type AiToolCall, type AiMessage } from "@/lib/api";

/**
 * Global AI agent panel hook.
 *
 * Manages:
 *   - Panel open/closed state + Cmd-J toggle
 *   - Current conversation id + message history
 *   - Streaming via aiApi.streamChat
 *   - Per-page context extraction from the URL
 *   - Streaming chunks (text deltas + tool calls + charts + citations)
 *
 * The hook is mounted once at the portal layout level. Pages don't
 * call it directly — they call ``useAiAgent().setPageContext({...})``
 * if they have a specific trace_id / incident_id / agent_id to attach.
 */

export interface ChatTurn {
  id: string;
  role: "user" | "assistant" | "tool";
  /** The user-visible text (markdown). For tool turns, the tool name + result. */
  text: string;
  /** All tool calls emitted during this assistant turn. */
  toolCalls: AiToolCall[];
  /** All chart specs emitted during this assistant turn. */
  charts: AiChartSpec[];
  /** All citations emitted during this assistant turn. */
  citations: AiCitation[];
  /** True while a stream is in flight for this turn. */
  streaming?: boolean;
}

export interface AiAgentState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** The current page context (auto-extracted from URL + manual setPageContext). */
  pageContext: Record<string, unknown>;
  setPageContext: (ctx: Record<string, unknown>) => void;
  /** Conversation state. */
  conversationId: string | null;
  turns: ChatTurn[];
  sending: boolean;
  error: string | null;
  /** Send one user message. Returns when the stream completes (or errors). */
  send: (message: string) => Promise<void>;
  /** Cancel the in-flight stream (if any). */
  cancel: () => void;
  /** Start a fresh conversation (clears turns but keeps panel open). */
  newConversation: () => void;
}

/**
 * Extract page context hints from the URL pathname. The portal's
 * routes follow patterns like:
 *   /observability/traces/[id]
 *   /incidents/[id]
 *   /agents/[id]
 *   /optimization/cost
 *
 * We use these to seed the agent's ``page_context`` automatically.
 */
function contextFromPath(pathname: string, search: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = { pathname };
  // Trace view
  let m = pathname.match(/^\/[^/]+\/observability\/traces\/([^/]+)/);
  if (m) out.trace_id = m[1];
  // Incident
  m = pathname.match(/^\/[^/]+\/incidents\/([^/]+)/);
  if (m) out.incident_id = m[1];
  // Agent
  m = pathname.match(/^\/[^/]+\/agents\/([^/]+)/);
  if (m) out.agent_id = m[1];
  // Optimization tab
  m = pathname.match(/^\/[^/]+\/optimization\/([^/]+)/);
  if (m) out.tab = m[1];
  // Query params win over path (explicit overrides).
  for (const [k, v] of search.entries()) {
    if (v) out[k] = v;
  }
  return out;
}

let _panelListeners: Set<(open: boolean) => void> = new Set();

/**
 * Imperative API to open the panel from anywhere in the app
 * (e.g. a page-level "Ask AI" button).
 */
export const aiAgentPanel = {
  open: () => {
    _panelListeners.forEach((cb) => cb(true));
  },
  close: () => {
    _panelListeners.forEach((cb) => cb(false));
  },
  toggle: () => {
    _panelListeners.forEach((cb) => {
      // We don't know current state here; consumers handle their own
      // toggle. This is a hint for "ensure visible".
      cb(true);
    });
  },
};

export function useAiAgent(orgId: string | null): AiAgentState {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [pageContext, setPageContext] = useState<Record<string, unknown>>({});
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-extract context from URL.
  useEffect(() => {
    const ctx = contextFromPath(pathname, new URLSearchParams(searchParams?.toString() ?? ""));
    setPageContext((prev) => ({ ...ctx, ...prev }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  // Cmd-J / Ctrl-J toggle.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = typeof navigator !== "undefined"
        && /Mac|iPhone|iPad/i.test(navigator.platform);
      const meta = isMac ? e.metaKey : e.ctrlKey;
      if (meta && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // External "open panel" calls.
  useEffect(() => {
    const cb = (next: boolean) => setOpen(next);
    _panelListeners.add(cb);
    return () => { _panelListeners.delete(cb); };
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setTurns((prev) => prev.map((t) =>
      t.streaming ? { ...t, streaming: false } : t,
    ));
  }, []);

  const send = useCallback(async (message: string) => {
    if (!orgId || !message.trim() || sending) return;
    setError(null);
    setSending(true);

    const userTurn: ChatTurn = {
      id: `local-${Date.now()}-user`,
      role: "user",
      text: message,
      toolCalls: [],
      charts: [],
      citations: [],
    };
    const assistantTurn: ChatTurn = {
      id: `local-${Date.now()}-assistant`,
      role: "assistant",
      text: "",
      toolCalls: [],
      charts: [],
      citations: [],
      streaming: true,
    };
    setTurns((prev) => [...prev, userTurn, assistantTurn]);

    abortRef.current = await aiApi.streamChat(
      orgId,
      {
        conversation_id: conversationId,
        message,
        page_context: pageContext,
      },
      {
        onTextDelta: (text) => {
          setTurns((prev) => prev.map((t) =>
            t.id === assistantTurn.id
              ? { ...t, text: t.text + text }
              : t,
          ));
        },
        onToolCall: (tc) => {
          setTurns((prev) => prev.map((t) =>
            t.id === assistantTurn.id
              ? { ...t, toolCalls: [...t.toolCalls, tc] }
              : t,
          ));
        },
        onChart: (chart) => {
          setTurns((prev) => prev.map((t) =>
            t.id === assistantTurn.id
              ? { ...t, charts: [...t.charts, chart] }
              : t,
          ));
        },
        onCitation: (cite) => {
          setTurns((prev) => prev.map((t) =>
            t.id === assistantTurn.id
              ? { ...t, citations: [...t.citations, cite] }
              : t,
          ));
        },
        onDone: (summary) => {
          setTurns((prev) => prev.map((t) =>
            t.id === assistantTurn.id
              ? { ...t, streaming: false }
              : t,
          ));
          if (summary.conversation_id) {
            setConversationId(summary.conversation_id);
          }
          setSending(false);
        },
        onError: (err) => {
          setError(err);
          setTurns((prev) => prev.map((t) =>
            t.id === assistantTurn.id
              ? { ...t, streaming: false, text: t.text || err }
              : t,
          ));
          setSending(false);
        },
      },
    );
  }, [orgId, conversationId, pageContext, sending]);

  const newConversation = useCallback(() => {
    cancel();
    setConversationId(null);
    setTurns([]);
    setError(null);
  }, [cancel]);

  return {
    open,
    setOpen,
    toggle,
    pageContext,
    setPageContext,
    conversationId,
    turns,
    sending,
    error,
    send,
    cancel,
    newConversation,
  };
}