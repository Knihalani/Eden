"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import {
  type Message,
  type Session,
  type ToolCall,
  type ChatChart,
  type ChatCitation,
  CHAT_PREFERRED_TIER,
  newMessageId,
  SIDEBAR_WIDTH,
  buildPageContext,
} from "../types";
import { executeClientToolAction } from "../clientToolExecutors";
import { expandSlashInput } from "../slashCommands";

export { SIDEBAR_WIDTH };

export function useChatSidebar() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  // useToast() returns a fresh object each render — keep a stable ref so
  // effects that call toast don't re-fire forever (Agent 11 / Merge B P0).
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const pathname = usePathname();
  const router = useRouter();

  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem("eden:ai-sidebar:open") === "1";
  });
  // Fail-closed until the public flag probe confirms f70=true.
  const [f70Enabled, setF70Enabled] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sessionCostUsd, setSessionCostUsd] = useState(0);
  const [costEstimateUsd, setCostEstimateUsd] = useState<number | null>(null);
  const [lastTtftMs, setLastTtftMs] = useState<number | null>(null);
  const [ttftBudgetMs, setTtftBudgetMs] = useState<number | null>(null);
  const [ttftWarning, setTtftWarning] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [showCoach, setShowCoach] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const panelRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const pendingPromptRef = useRef<string | null>(null);
  const submitRef = useRef<(override?: string) => Promise<void>>(async () => {});
  const navigateRef = useRef<(href: string) => void>((href) => {
    router.push(href);
  });

  const orgId = currentOrg?.id;
  const hideChatOnRoute =
    pathname === "/onboarding" || (pathname?.startsWith("/onboarding/") ?? false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem("eden:ai-sidebar:open", open ? "1" : "0");
  }, [open]);

  useEffect(() => {
    navigateRef.current = (href: string) => {
      router.push(href);
    };
  }, [router]);

  useEffect(() => {
    const onToggle = () => setOpen((v) => !v);
    const onAsk = (ev: Event) => {
      const detail = (ev as CustomEvent<{ prompt?: string }>).detail;
      setOpen(true);
      if (detail?.prompt?.trim()) {
        pendingPromptRef.current = detail.prompt.trim();
        setInput(detail.prompt.trim());
      }
    };
    window.addEventListener("eden:toggle-ai-chat", onToggle);
    window.addEventListener("eden:ask-ai", onAsk as EventListener);
    return () => {
      window.removeEventListener("eden:toggle-ai-chat", onToggle);
      window.removeEventListener("eden:ask-ai", onAsk as EventListener);
    };
  }, []);

  // Deep-link ?ai=1&ai_prompt=… opens sidebar and queues a send.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("ai") !== "1") return;
    setOpen(true);
    const prompt = params.get("ai_prompt");
    if (prompt?.trim()) {
      pendingPromptRef.current = prompt.trim();
      setInput(prompt.trim());
    }
    params.delete("ai");
    params.delete("ai_prompt");
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, []);

  // Coach mark once per browser until dismissed.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem("eden:ai-coach-seen") !== "1") {
        setShowCoach(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // features.f70 — public flag; fail-closed (hide) when probe fails or f70=false.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy/feature-flags", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) return null;
        return (await r.json()) as { f70?: boolean };
      })
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data.f70 === "boolean") {
          setF70Enabled(data.f70);
          return;
        }
        setF70Enabled(false);
      })
      .catch(() => {
        if (!cancelled) setF70Enabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    setStreaming(false);
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        next[next.length - 1] = { ...last, streaming: false };
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Slash/mention picker owns Escape while open — don't close the sidebar.
      const t = e.target as HTMLElement | null;
      if (
        t?.closest?.('[role="listbox"]') ||
        t?.closest?.("[data-ai-picker-open]")
      ) {
        return;
      }
      e.preventDefault();
      setOpen(false);
      stopStreaming();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, stopStreaming]);

  // Focus trap when open (desktop aside; Sheet handles mobile via Radix).
  // Only (re)focus session chrome when the panel opens — not on every
  // messages.length change after send (that steals focus from the composer).
  useEffect(() => {
    if (!open || isMobile) return;
    const root = panelRef.current;
    if (!root) return;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], textarea, input, select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
    const first = focusables()[0];
    first?.focus();
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    root.addEventListener("keydown", onTab);
    return () => root.removeEventListener("keydown", onTab);
  }, [open, isMobile]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const main = document.getElementById("main-content");
    if (!main) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const apply = () => {
      if (open && mq.matches && orgId && f70Enabled) {
        main.style.marginRight = `${SIDEBAR_WIDTH}px`;
        main.style.transition = "margin-right 200ms ease-out";
      } else {
        main.style.marginRight = "";
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      main.style.marginRight = "";
    };
  }, [open, orgId, f70Enabled]);

  const refreshSessions = useCallback(() => {
    if (!orgId) return;
    setLoadingSessions(true);
    setSessionsError(null);
    fetch(`/api/ai-insights/sessions?org_id=${orgId}`, { credentials: "include" })
      .then(async (r) => {
        if (r.status >= 500) throw new Error(`Sessions unavailable (HTTP ${r.status})`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { sessions: Session[] };
      })
      .then((data) => {
        setSessions(data.sessions);
        setSessionsError(null);
      })
      .catch((err) => {
        console.warn("ai-insights: list sessions failed", err);
        setSessions([]);
        setSessionsError(err instanceof Error ? err.message : "Failed to load sessions");
      })
      .finally(() => setLoadingSessions(false));
  }, [orgId]);

  useEffect(() => {
    // Abort in-flight stream and clear session binding on org change to
    // prevent cross-org contamination (session_id / messages from prior org).
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    setStreaming(false);
    setSessionsError(null);
    setActiveSessionId((id) => (id === null ? id : null));
    setMessages((m) => (m.length === 0 ? m : []));
    setSessionCostUsd(0);
    if (!orgId) {
      // Guarded setters: bare setX([]) re-renders forever (new [] !== prev []).
      setSessions((s) => (s.length === 0 ? s : []));
      return;
    }
    refreshSessions();
  }, [orgId, refreshSessions]);

  // Rehydrate messages when the user picks a session.
  useEffect(() => {
    if (!orgId || !activeSessionId) {
      if (!activeSessionId) {
        setMessages((m) => (m.length === 0 ? m : []));
      }
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
        const rehydrated: Message[] = data.messages.map((m, idx) => {
          const blocks = Array.isArray(m.content)
            ? (m.content as Array<{ type: string; [k: string]: unknown }>)
            : [];
          if (m.role === "user") {
            return {
              id: newMessageId(),
              role: "user" as const,
              text: blocks
                .filter((b) => b.type === "text")
                .map((b) => String(b.text ?? ""))
                .join("\n"),
            };
          }
          if (m.role === "assistant") {
            const toolCalls: ToolCall[] = blocks
              .filter((b) => b.type === "tool_use")
              .map((b) => ({
                id: String(b.id ?? newMessageId()),
                name: String(b.name ?? ""),
                input: (b.input as Record<string, unknown>) ?? {},
                result: b.result
                  ? { status: "ok" as const, output: b.result }
                  : undefined,
              }));
            const charts = blocks
              .filter((b) => b.type === "chart" && b.chart)
              .map((b) => b.chart as ChatChart);
            const citations = blocks
              .filter((b) => b.type === "citation" && b.citation)
              .map((b) => b.citation as ChatCitation);
            return {
              id: newMessageId(),
              role: "assistant" as const,
              text: blocks
                .filter((b) => b.type === "text")
                .map((b) => String(b.text ?? ""))
                .join("\n"),
              toolCalls: toolCalls.length ? toolCalls : undefined,
              charts: charts.length ? charts : undefined,
              citations: citations.length ? citations : undefined,
            };
          }
          return { id: `tool-${idx}-${newMessageId()}`, role: "tool" as const };
        });
        setMessages(rehydrated);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("ai-insights: rehydrate failed", err);
        toastRef.current.error("Failed to load conversation");
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, activeSessionId]);

  // Sticky scroll: track whether the user is near the bottom. If they
  // scrolled up to read history, do not force scrollTop on new tokens.
  // Re-bind on open/session/messages so the listener attaches after the
  // panel mounts (scrollRef is null while the aside is unmounted).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const NEAR_BOTTOM_PX = 80;
    const onScroll = () => {
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    return () => el.removeEventListener("scroll", onScroll);
  }, [messages, streaming, open, activeSessionId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      streamingRef.current = false;
    };
  }, []);

  const newChat = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setSessionCostUsd(0);
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
        toastRef.current.success("Conversation archived");
      } catch (err) {
        console.warn("ai-insights: archive failed", err);
        toastRef.current.error("Could not archive conversation");
      }
    },
    [orgId, activeSessionId],
  );

  const dismissCoach = useCallback(() => {
    setShowCoach(false);
    try {
      window.localStorage.setItem("eden:ai-coach-seen", "1");
    } catch {
      /* ignore */
    }
  }, []);

  const submit = useCallback(async (overrideText?: string) => {
    const raw = (overrideText ?? input).trim();
    const text = expandSlashInput(raw) ?? raw;
    if (!text || streaming || !orgId) return;
    stickToBottomRef.current = true;
    setInput("");
    dismissCoach();
    setTtftWarning(null);

    const userId = newMessageId();
    const assistantId = newMessageId();
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text },
      {
        id: assistantId,
        role: "assistant",
        text: "",
        streaming: true,
        toolCalls: [],
        charts: [],
        citations: [],
      },
    ]);
    streamingRef.current = true;
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let response: Response;
    try {
      response = await fetch(`/api/ai-insights/chat?org_id=${orgId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          session_id: activeSessionId,
          page_context: buildPageContext(pathname),
          preferred_tier: CHAT_PREFERRED_TIER,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        streamingRef.current = false;
        setStreaming(false);
        setMessages((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === "assistant" && last.streaming) {
            next[next.length - 1] = { ...last, streaming: false };
            return next;
          }
          return prev;
        });
        return;
      }
      streamingRef.current = false;
      setStreaming(false);
      setMessages((prev) => {
        const next = prev.slice(0, -1);
        return [
          ...next,
          {
            id: assistantId,
            role: "assistant",
            text: `Network error: ${err instanceof Error ? err.message : "unknown"}`,
            isError: true,
          },
        ];
      });
      toastRef.current.error("Could not reach AI Insights");
      return;
    }

    if (!response.ok || !response.body) {
      streamingRef.current = false;
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
        return [
          ...next,
          { id: assistantId, role: "assistant", text: `Error: ${detail}`, isError: true },
        ];
      });
      toastRef.current.error(detail);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleEvent = (ev: { type: string; [k: string]: unknown }) => {
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
          const delta = String(ev.text ?? "");
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              next[next.length - 1] = { ...last, text: (last.text ?? "") + delta };
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
          const status = (ev.status as "ok" | "error") ?? "ok";
          const output = ev.output;
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
                      status,
                      output,
                      duration_ms:
                        typeof ev.duration_ms === "number" ? ev.duration_ms : undefined,
                    },
                  };
                  next[i] = { ...m, toolCalls: updated };
                  return next;
                }
              }
            }
            return next;
          });
          if (status === "ok") {
            executeClientToolAction(output, {
              navigate: (href) => navigateRef.current(href),
            });
          }
          break;
        }
        case "chart": {
          const chart = ev.chart as ChatChart | undefined;
          if (!chart) return;
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                charts: [...(last.charts ?? []), chart],
              };
            }
            return next;
          });
          break;
        }
        case "citation": {
          const citation = ev.citation as ChatCitation | undefined;
          if (!citation) return;
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                citations: [...(last.citations ?? []), citation],
              };
            }
            return next;
          });
          break;
        }
        case "done": {
          const doneCost =
            typeof ev.cost_usd === "number"
              ? ev.cost_usd
              : typeof ev.turn_cost_usd === "number"
                ? ev.turn_cost_usd
                : undefined;
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                streaming: false,
                ...(doneCost != null ? { costUsd: doneCost } : {}),
              };
            }
            return next;
          });
          if (typeof doneCost === "number" && doneCost > 0) {
            setSessionCostUsd((c) => c + doneCost);
          }
          streamingRef.current = false;
          setStreaming(false);
          break;
        }
        case "cost": {
          const turn = typeof ev.turn_cost_usd === "number" ? ev.turn_cost_usd : 0;
          const total = typeof ev.cost_usd === "number" ? ev.cost_usd : turn;
          if (typeof ev.ttft_ms === "number") setLastTtftMs(ev.ttft_ms);
          if (typeof ev.ttft_budget_ms === "number") setTtftBudgetMs(ev.ttft_budget_ms);
          const est = ev.cost_estimate as { estimated_usd?: number } | undefined;
          if (est && typeof est.estimated_usd === "number") {
            setCostEstimateUsd(est.estimated_usd);
          }
          if (total > 0) {
            setMessages((prev) => {
              const next = prev.slice();
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { ...last, costUsd: total };
              }
              return next;
            });
          }
          break;
        }
        case "meta": {
          if (typeof ev.ttft_ms === "number") setLastTtftMs(ev.ttft_ms);
          if (typeof ev.ttft_budget_ms === "number") setTtftBudgetMs(ev.ttft_budget_ms);
          if (typeof ev.ttft_warning === "string") setTtftWarning(ev.ttft_warning);
          const est = ev.cost_estimate as { estimated_usd?: number } | undefined;
          if (est && typeof est.estimated_usd === "number") {
            setCostEstimateUsd(est.estimated_usd);
          }
          if (typeof ev.warning === "string" && /cite-before-claim/i.test(ev.warning)) {
            toastRef.current.error(ev.warning);
          }
          break;
        }
        case "error": {
          const msg = String(ev.message ?? ev.error ?? "Unknown error");
          const isBudget = /budget/i.test(msg) || /hard cap/i.test(msg);
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              next[next.length - 1] = {
                ...last,
                text:
                  (last.text ?? "") +
                  (last.text ? "\n\n" : "") +
                  (isBudget ? `Stopped: ${msg}` : `Error: ${msg}`),
                streaming: false,
                isError: true,
              };
            } else {
              next.push({
                id: newMessageId(),
                role: "assistant",
                text: isBudget ? `Stopped: ${msg}` : `Error: ${msg}`,
                isError: true,
              });
            }
            return next;
          });
          streamingRef.current = false;
          setStreaming(false);
          if (isBudget) {
            abortRef.current?.abort();
            abortRef.current = null;
          }
          toastRef.current.error(msg);
          break;
        }
        default:
          break;
      }
    };

    const flushEvent = (rawEvent: string) => {
      const dataLines = rawEvent
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) return;
      let parsed: { type: string; [k: string]: unknown };
      try {
        parsed = JSON.parse(dataLines.join("\n"));
      } catch {
        return;
      }
      handleEvent(parsed);
    };

    try {
      while (true) {
        if (controller.signal.aborted) {
          await reader.cancel();
          break;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          flushEvent(raw);
        }
      }
      if (buffer.trim() && !controller.signal.aborted) {
        flushEvent(buffer);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.warn("ai-insights: stream error", err);
        setMessages((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === "assistant" && last.streaming) {
            next[next.length - 1] = {
              ...last,
              text: (last.text ?? "") + (last.text ? "\n\n" : "") + "Stream interrupted",
              streaming: false,
              isError: true,
            };
          }
          return next;
        });
      }
    } finally {
      streamingRef.current = false;
      setStreaming(false);
      abortRef.current = null;
      // Clear message.streaming on every stream-exit path (abort, error,
      // premature close), not only done/stop — otherwise the cursor sticks.
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          next[next.length - 1] = { ...last, streaming: false };
          return next;
        }
        return prev;
      });
      if (orgId && !controller.signal.aborted) {
        refreshSessions();
      }
    }
  }, [
    activeSessionId,
    input,
    orgId,
    pathname,
    streaming,
    refreshSessions,
    dismissCoach,
  ]);

  submitRef.current = submit;

  // Fire deep-link / Ask AI queued prompt once org is ready.
  useEffect(() => {
    if (!orgId || streaming || !pendingPromptRef.current) return;
    const prompt = pendingPromptRef.current;
    pendingPromptRef.current = null;
    void submitRef.current(prompt);
  }, [orgId, streaming, open]);

  const activeSession = sessions.find((s) => s.session_id === activeSessionId);
  const sessionLabel = activeSession?.title ?? "New chat";

  return {
    open,
    setOpen,
    f70Enabled,
    hideChatOnRoute,
    isMobile,
    hasOrg: !!orgId,
    orgId,
    sessions,
    sessionsError,
    loadingSessions,
    activeSessionId,
    setActiveSessionId,
    sessionMenuOpen,
    setSessionMenuOpen,
    sessionLabel,
    messages,
    input,
    setInput,
    streaming,
    sessionCostUsd,
    costEstimateUsd,
    lastTtftMs,
    ttftBudgetMs,
    ttftWarning,
    scrollRef,
    panelRef,
    stopStreaming,
    newChat,
    archiveSession,
    submit,
    refreshSessions,
    showCoach,
    dismissCoach,
  };
}
