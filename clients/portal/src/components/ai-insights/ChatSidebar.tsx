"use client";

/**
 * ChatSidebar — persistent right-hand AI assistant sidebar.
 *
 * Lifecycle:
 *   1. On mount, fetch the user's recent sessions and render them in
 *      the header list.
 *   2. When the user sends a message, append it to the current
 *      session (or create a new one) and POST to
 *      ``/api/ai-insights/chat`` which forwards the cookie + streams
 *      SSE back from FastAPI.
 *   3. As events land, append to the in-memory transcript:
 *        - ``session``   — record the new session id
 *        - ``text_delta``— append to the in-flight assistant message
 *        - ``tool_call`` — render a ``ToolCallCard`` in "running" state
 *        - ``tool_result``— update the matching card with the result
 *        - ``done``      — clear the in-flight state, allow new input
 *        - ``error``     — surface a toast, mark transcript as errored
 *
 * Persistence: every turn is also written to
 * ``ai_insights_chat_messages`` server-side, so the user can navigate
 * away from a page and come back to the same transcript.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Plus,
  Send,
  X,
  PanelRightClose,
  Loader2,
  AlertTriangle,
  Archive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { ToolCallCard } from "./ToolCallCard";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface Session {
  session_id: string;
  title: string;
  updated_at: string | null;
  archived: boolean;
}

interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: {
    status: "ok" | "error";
    output?: unknown;
    duration_ms?: number;
  };
}

interface Message {
  role: "user" | "assistant" | "tool";
  /** Text content for user/assistant; tool messages render via the tool_call list. */
  text?: string;
  /** Pending tool calls for the assistant turn; results are attached by id. */
  toolCalls?: ToolCall[];
  /** True while a server stream for this turn is still in flight. */
  streaming?: boolean;
}

const SIDEBAR_WIDTH = 360;

export function ChatSidebar() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  // ponytail: open state is persisted to sessionStorage so a
  // returning user sees the AI assistant in the state they left it.
  // Default is closed — the user explicitly opts in via the
  // floating toggle button (bottom-right). The previous behavior
  // (always closed, no persistence) made accidental click-throughs
  // impossible to recover from without a page reload. June 2026 fix.
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem("eden:ai-sidebar:open") === "1";
  });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem("eden:ai-sidebar:open", open ? "1" : "0");
  }, [open]);

  // ponytail: Esc closes the chat. Saves the user from hunting for
  // the close button when the chat covers the right side of the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const orgId = currentOrg?.id;

  // Load the user's session list whenever the org changes.
  useEffect(() => {
    if (!orgId) {
      setSessions([]);
      setActiveSessionId(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingSessions(true);
    fetch(`/api/ai-insights/sessions?org_id=${orgId}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { sessions: Session[] };
      })
      .then((data) => {
        if (cancelled) return;
        setSessions(data.sessions);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("ai-insights: list sessions failed", err);
        // Don't toast on initial load — keep the sidebar usable.
      })
      .finally(() => {
        if (!cancelled) setLoadingSessions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Rehydrate a session's messages when the user picks it.
  useEffect(() => {
    if (!orgId || !activeSessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    fetch(
      `/api/ai-insights/sessions/${activeSessionId}/messages?org_id=${orgId}`,
      { credentials: "include" },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as {
          messages: Array<{ role: string; content: unknown }>;
        };
      })
      .then((data) => {
        if (cancelled) return;
        const rehydrated: Message[] = data.messages.map((m) => {
          const blocks = Array.isArray(m.content) ? (m.content as Array<{ type: string; [k: string]: unknown }>) : [];
          if (m.role === "user") {
            return {
              role: "user",
              text: blocks
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n"),
            };
          }
          if (m.role === "assistant") {
            return {
              role: "assistant",
              text: blocks
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n"),
            };
          }
          // tool turn — the UI doesn't render tool messages directly;
          // the assistant's tool_call list is what surfaces results.
          return { role: "tool" };
        });
        setMessages(rehydrated);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("ai-insights: rehydrate failed", err);
        toast.error("Failed to load conversation");
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, activeSessionId, toast]);

  // Auto-scroll the transcript when new content lands.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Clean up any open stream on unmount.
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  const newChat = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
  }, []);

  const archiveSession = useCallback(
    async (id: string) => {
      if (!orgId) return;
      try {
        const r = await fetch(
          `/api/ai-insights/sessions/${id}/archive?org_id=${orgId}`,
          { method: "POST", credentials: "include" },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setSessions((prev) =>
          prev.map((s) => (s.session_id === id ? { ...s, archived: true } : s)),
        );
        if (activeSessionId === id) {
          setActiveSessionId(null);
          setMessages([]);
        }
        toast.success("Conversation archived");
      } catch (err) {
        console.warn("ai-insights: archive failed", err);
        toast.error("Could not archive conversation");
      }
    },
    [orgId, activeSessionId, toast],
  );

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !orgId) return;
    setInput("");

    // Optimistic append so the user sees their message immediately.
    setMessages((prev) => [...prev, { role: "user", text }]);
    // Make sure an in-flight assistant message exists.
    setMessages((prev) => [
      ...prev,
      { role: "assistant", text: "", streaming: true, toolCalls: [] },
    ]);
    setStreaming(true);

    // Use POST + fetch streaming (the backend returns text/event-stream).
    // We can't use EventSource here because it doesn't support POST.
    let response: Response;
    try {
      response = await fetch(`/api/ai-insights/chat?org_id=${orgId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: activeSessionId }),
      });
    } catch (err) {
      setStreaming(false);
      setMessages((prev) => {
        const next = prev.slice(0, -1);
        return [
          ...next,
          {
            role: "assistant",
            text: `_Network error: ${err instanceof Error ? err.message : "unknown"}_`,
          },
        ];
      });
      toast.error("Could not reach AI Insights");
      return;
    }

    if (!response.ok || !response.body) {
      setStreaming(false);
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        detail = body.detail ?? detail;
      } catch {
        /* ignore */
      }
      setMessages((prev) => {
        const next = prev.slice(0, -1);
        return [...next, { role: "assistant", text: `_Error: ${detail}_` }];
      });
      toast.error(detail);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const flushEvent = (rawEvent: string) => {
      // SSE format: ``event: <type>\ndata: <json>\n\n`` (we only need
      // the data line; the event type is also embedded in the JSON
      // payload for safety).
      const dataLines = rawEvent
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) return;
      const payload = dataLines.join("\n");
      let parsed: { type: string; [k: string]: unknown };
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      handleEvent(parsed);
    };

    const handleEvent = (
      ev: { type: string; [k: string]: unknown },
    ) => {
      switch (ev.type) {
        case "session": {
          const id = String(ev.session_id ?? "");
          if (!id) return;
          setActiveSessionId(id);
          setSessions((prev) => {
            if (prev.some((s) => s.session_id === id)) return prev;
            return [
              {
                session_id: id,
                title: String(ev.title ?? "New chat"),
                updated_at: new Date().toISOString(),
                archived: false,
              },
              ...prev,
            ];
          });
          break;
        }
        case "text_delta": {
          const text = String(ev.text ?? "");
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              next[next.length - 1] = { ...last, text: (last.text ?? "") + text };
            }
            return next;
          });
          break;
        }
        case "tool_call": {
          const tc: ToolCall = {
            id: String(ev.id),
            name: String(ev.name),
            input: (ev.input as Record<string, unknown>) ?? {},
          };
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              const toolCalls = [...(last.toolCalls ?? []), tc];
              next[next.length - 1] = { ...last, toolCalls };
            }
            return next;
          });
          break;
        }
        case "tool_result": {
          const id = String(ev.id);
          setMessages((prev) => {
            const next = prev.slice();
            for (let i = next.length - 1; i >= 0; i--) {
              const m = next[i];
              if (m.role === "assistant" && m.toolCalls) {
                const idx = m.toolCalls.findIndex((t) => t.id === id);
                if (idx !== -1) {
                  const updated = [...m.toolCalls];
                  updated[idx] = {
                    ...updated[idx],
                    result: {
                      status: (ev.status as "ok" | "error") ?? "ok",
                      output: ev.output,
                      duration_ms: typeof ev.duration_ms === "number" ? ev.duration_ms : undefined,
                    },
                  };
                  next[i] = { ...m, toolCalls: updated };
                  return next;
                }
              }
            }
            return next;
          });
          break;
        }
        case "done": {
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = { ...last, streaming: false };
            }
            return next;
          });
          setStreaming(false);
          break;
        }
        case "error": {
          const msg = String(ev.message ?? "Unknown error");
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              next[next.length - 1] = {
                ...last,
                text: (last.text ?? "") + `\n\n_Error: ${msg}_`,
                streaming: false,
              };
            } else {
              next.push({ role: "assistant", text: `_Error: ${msg}_` });
            }
            return next;
          });
          setStreaming(false);
          toast.error(msg);
          break;
        }
        default:
          break;
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // SSE messages are separated by a blank line (``\n\n``).
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          flushEvent(raw);
        }
      }
      // Drain any trailing event.
      if (buffer.trim()) {
        flushEvent(buffer);
      }
    } catch (err) {
      console.warn("ai-insights: stream error", err);
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          next[next.length - 1] = {
            ...last,
            text: (last.text ?? "") + `\n\n_Stream interrupted_`,
            streaming: false,
          };
        }
        return next;
      });
      setStreaming(false);
    } finally {
      // Refresh the session list so the title is up to date.
      if (orgId) {
        fetch(`/api/ai-insights/sessions?org_id=${orgId}`, { credentials: "include" })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            if (data && Array.isArray(data.sessions)) {
              setSessions(data.sessions as Session[]);
            }
          })
          .catch(() => {});
      }
    }
  }, [activeSessionId, input, orgId, streaming, toast]);

  const hasOrg = !!orgId;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop — click to close. Always behind the panel. */}
      {open && (
        <button
          type="button"
          aria-label="Close AI assistant"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-20 bg-transparent cursor-default border-0 p-0"
        />
      )}

      {/* Floating toggle button (always visible, even when collapsed). */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-4 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full",
          "bg-[var(--accent)] text-[var(--bg-base)] shadow-lg transition-transform",
          "hover:scale-105 active:scale-95",
          open && "translate-x-[180px]",
        )}
        aria-label={open ? "Close AI assistant" : "Open AI assistant"}
      >
        {open ? <PanelRightClose className="h-5 w-5" /> : <MessageSquare className="h-5 w-5" />}
      </button>

      {open && hasOrg && (
        <aside
          className={cn(
            "fixed right-0 top-0 z-30 flex h-screen flex-col",
            "border-l border-[var(--border-default)] bg-[var(--bg-primary)]",
            "shadow-2xl",
          )}
          style={{ width: SIDEBAR_WIDTH }}
          role="complementary"
          aria-label="AI Insights assistant"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-[var(--accent)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                AI Insights
              </h2>
              <Tag className="text-[10px]">Beta</Tag>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={newChat}
                aria-label="New chat"
                className="h-7 w-7 p-0"
              >
                <Plus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
                aria-label="Close sidebar"
                className="h-7 w-7 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Sessions list */}
          <div className="max-h-40 overflow-y-auto border-b border-[var(--border-subtle)] px-2 py-2">
            {loadingSessions ? (
              <div className="flex items-center justify-center py-3 text-xs text-[var(--text-muted)]">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                Loading…
              </div>
            ) : sessions.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--text-muted)]">
                No conversations yet. Ask a question to start one.
              </div>
            ) : (
              <ul className="space-y-1">
                {sessions.map((s) => (
                  <li key={s.session_id}>
                    <button
                      type="button"
                      onClick={() => setActiveSessionId(s.session_id)}
                      className={cn(
                        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                        s.session_id === activeSessionId
                          ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
                        s.archived && "opacity-50",
                      )}
                    >
                      <MessageSquare className="h-3 w-3 flex-shrink-0" />
                      <span className="flex-1 truncate">{s.title}</span>
                      {!s.archived && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            archiveSession(s.session_id);
                          }}
                          className="hidden text-[var(--text-muted)] hover:text-[var(--text-primary)] group-hover:block"
                          aria-label="Archive"
                        >
                          <Archive className="h-3 w-3" />
                        </button>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Transcript */}
          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
          >
            {messages.length === 0 && (
              <div className="rounded-md border border-dashed border-[var(--border-subtle)] p-3 text-xs text-[var(--text-muted)]">
                Ask anything about your jobs, references, or org activity.
                Examples:
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  <li>How many jobs completed today?</li>
                  <li>Find my last cartpole run</li>
                  <li>Summarize this week&apos;s outcomes</li>
                </ul>
              </div>
            )}
            {messages.map((m, i) => (
              <MessageBlock key={i} message={m} />
            ))}
          </div>

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="border-t border-[var(--border-default)] p-3"
          >
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={2}
                placeholder={
                  streaming
                    ? "Streaming…"
                    : "Ask about your data…"
                }
                disabled={streaming}
                className={cn(
                  "flex-1 resize-none rounded-md border border-[var(--border-default)]",
                  "bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-primary)]",
                  "placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]",
                  "focus:outline-none disabled:opacity-50",
                )}
              />
              <Button
                type="submit"
                size="sm"
                disabled={!input.trim() || streaming}
                className="h-9 w-9 p-0"
                aria-label="Send"
              >
                {streaming ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </form>
        </aside>
      )}

      {!hasOrg && open && (
        <div className="fixed bottom-20 right-4 z-50 max-w-xs rounded-md border border-[var(--warning)]/40 bg-[var(--bg-primary)] p-3 text-xs text-[var(--text-secondary)] shadow-lg">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-[var(--warning)]" />
            <div>
              Select an organization from the sidebar to use AI Insights.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MessageBlock({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-[var(--bg-base)]">
          {message.text}
        </div>
      </div>
    );
  }
  if (message.role === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">
          {message.toolCalls?.map((tc) => (
            <ToolCallCard
              key={tc.id}
              id={tc.id}
              name={tc.name}
              input={tc.input}
              result={tc.result}
            />
          ))}
          {message.text && (
            <div className="whitespace-pre-wrap break-words">
              {message.text}
              {message.streaming && (
                <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-[var(--accent)]" />
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  // tool message — never rendered directly; tool results ride along
  // with the assistant turn.
  return null;
}
