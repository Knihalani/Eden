"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { useQueryPatch } from "@/lab/agent-scope";
import {
  newEmptyThread,
  pinFromParams,
  type AgentArtifact,
  type AgentChartType,
  type AgentCitation,
  type AgentCitationKind,
  type AgentContextPin,
  type AgentMessage,
  type AgentMessagePart,
  type AgentThread,
} from "@/lab/fixtures/agent-chat";
import {
  AgentModeNav,
  parseAgentView,
  type AgentViewMode,
} from "@/lab/agent/agent-chrome";
import {
  AgentChatStream,
  AgentHistoryRail,
} from "@/lab/agent/agent-chat-view";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { fetchApi } from "@/lib/api/core";
import { ASSIST_STALE, SHELL_QUERY } from "@/lib/portal-query";
import { useLabToast } from "@/lab/lab-toast";
import { QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";

function titleFromPrompt(prompt: string): string {
  const t = prompt.trim();
  if (t.length <= 42) return t || "New chat";
  return `${t.slice(0, 40)}…`;
}

/** Raw shape of one SSE `AgentChunk` (see src/eden/autonomous/agent.py). */
type ChatChunk = {
  type: string;
  text?: string;
  chart?: {
    type: string;
    title: string;
    data: Record<string, unknown>[];
    x_key?: string;
    y_key?: string;
    y2_key?: string;
    label_key?: string;
    value_key?: string;
    unit?: string;
  };
  citation?: {
    kind: string;
    id: string;
    label: string;
    excerpt?: string;
    trace_id?: string;
  };
  error?: string;
  message?: string;
  conversation_id?: string;
};

function mapCitation(c: NonNullable<ChatChunk["citation"]>): AgentCitation {
  const kindMap: Record<string, AgentCitationKind> = {
    trace: "trace",
    span: "trace",
    incident: "issue",
    agent: "agent",
  };
  return {
    kind: kindMap[c.kind] ?? "trace",
    id: c.kind === "span" ? c.trace_id || c.id : c.id,
    label: c.label,
  };
}

const CHART_TYPE_MAP: Partial<Record<string, AgentChartType>> = {
  line: "line",
  bar: "bar",
  pie: "pie",
  scatter: "line",
};

function mapChart(chart: NonNullable<ChatChunk["chart"]>): AgentArtifact | null {
  const chartType = CHART_TYPE_MAP[chart.type];
  if (!chartType) return null; // table / heatmap / sankey have no renderer yet
  const labelKey = chart.label_key || chart.x_key || "label";
  const valueKey = chart.value_key || chart.y_key || "value";
  const points = chart.data.map((row) => ({
    label: String(row[labelKey] ?? ""),
    value: Number(row[valueKey] ?? 0),
    value2: chart.y2_key ? Number(row[chart.y2_key] ?? 0) : undefined,
  }));
  return {
    id: `chart_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind: "chart",
    title: chart.title,
    chartType,
    unit: chart.unit || undefined,
    points,
    filename: chart.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "chart",
  };
}

/** Parse one SSE frame's `data:` line(s) back into a chunk object. */
function parseSseFrame(frame: string): ChatChunk | null {
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as ChatChunk;
  } catch {
    return null;
  }
}

function LabAgentInner() {
  const searchParams = useSearchParams();
  const paramThread = searchParams.get("thread");
  const paramView = searchParams.get("view");
  const paramPrompt = searchParams.get("ai_prompt");
  const paramTrace = searchParams.get("traceId");
  const paramIssue = searchParams.get("issueId");
  const paramPlan = searchParams.get("planId");
  const paramAgent = searchParams.get("agent");

  const patchQuery = useQueryPatch();
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const syncedThreadUrl = useRef(false);
  const bootedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const conversationIdsRef = useRef<Record<string, string>>({});
  const { pushToast } = useLabToast();

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const threadsQuery = useOrgQuery(
    queryKeys.portal.assistantThreads(orgId),
    orgId,
    () => portalApi.assistantThreads(orgId!),
    { ...SHELL_QUERY, staleTime: ASSIST_STALE },
  );

  const [view, setView] = useState<AgentViewMode>(() =>
    parseAgentView(paramView),
  );
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [seededPrompt, setSeededPrompt] = useState<string | null>(null);

  // Org switch must re-boot — otherwise prior-org threads / conversation
  // IDs stay in local state and can POST into the new workspace.
  useEffect(() => {
    bootedRef.current = false;
    conversationIdsRef.current = {};
    syncedThreadUrl.current = false;
    setThreads([]);
    setActiveId("");
    setDraft("");
    setThinking(false);
    setSeededPrompt(null);
  }, [orgId]);

  // Boot once live threads have resolved (or failed) — mirrors the
  // previous synchronous fixture-driven boot, just deferred one tick.
  useEffect(() => {
    if (bootedRef.current) return;
    if (threadsQuery.isLoading) return;
    bootedRef.current = true;

    const pins = pinFromParams({
      traceId: paramTrace,
      issueId: paramIssue,
      planId: paramPlan,
      agentId: paramAgent,
    });
    const base = (threadsQuery.data ?? []).filter((x) => x.id !== "thr_empty");
    const wantsHandoff =
      pins.length > 0 ||
      Boolean(paramPrompt) ||
      paramThread === "thr_empty";
    if (wantsHandoff && (!paramThread || paramThread === "thr_empty")) {
      const t = newEmptyThread();
      t.pins = [...pins];
      if (pins.length > 0) {
        const labels = pins.map((p) => p.label).join(" · ");
        t.title = labels.length > 42 ? `${labels.slice(0, 40)}…` : labels;
      }
      setThreads([t, ...base]);
      setActiveId(t.id);
      return;
    }
    if (
      paramThread &&
      paramThread !== "thr_empty" &&
      base.some((t) => t.id === paramThread)
    ) {
      setThreads(base);
      setActiveId(paramThread);
      return;
    }
    if (base.length > 0) {
      setThreads(base);
      setActiveId(base[0]!.id);
      return;
    }
    const t = newEmptyThread();
    setThreads([t]);
    setActiveId(t.id);
  }, [
    orgId,
    threadsQuery.isLoading,
    threadsQuery.data,
    paramThread,
    paramPrompt,
    paramTrace,
    paramIssue,
    paramPlan,
    paramAgent,
  ]);

  const urlPins = useMemo(
    () =>
      pinFromParams({
        traceId: paramTrace,
        issueId: paramIssue,
        planId: paramPlan,
        agentId: paramAgent,
      }),
    [paramTrace, paramIssue, paramPlan, paramAgent],
  );

  // Persist handoff thread id into the URL once.
  useEffect(() => {
    if (syncedThreadUrl.current) return;
    if (!activeId || (paramThread && paramThread === activeId)) {
      syncedThreadUrl.current = true;
      return;
    }
    if (!paramThread || paramThread === "thr_empty") {
      syncedThreadUrl.current = true;
      patchQuery({ thread: activeId, view: null });
    }
  }, [activeId, paramThread, patchQuery]);

  useEffect(() => {
    setView(parseAgentView(paramView));
  }, [paramView]);

  useEffect(() => {
    if (
      paramThread &&
      paramThread !== "thr_empty" &&
      threads.some((t) => t.id === paramThread)
    ) {
      setActiveId(paramThread);
    }
  }, [paramThread, threads]);

  // Merge late-arriving URL pins into the active handoff thread.
  useEffect(() => {
    if (urlPins.length === 0 || !activeId) return;
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== activeId) return t;
        const next = [...t.pins];
        let changed = false;
        for (const pin of urlPins) {
          if (!next.some((p) => p.kind === pin.kind && p.id === pin.id)) {
            next.push(pin);
            changed = true;
          }
        }
        return changed ? { ...t, pins: next } : t;
      }),
    );
  }, [urlPins, activeId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const active =
    (activeId ? threads.find((t) => t.id === activeId) : undefined) ??
    threads[0];

  const selectThread = useCallback(
    (id: string) => {
      abortRef.current?.abort();
      setThinking(false);
      setActiveId(id);
      setView("chat");
      setDraft("");
      patchQuery({ thread: id, view: null });
    },
    [patchQuery],
  );

  const startNew = useCallback(() => {
    abortRef.current?.abort();
    setThinking(false);
    const t = newEmptyThread();
    if (urlPins.length > 0) t.pins = [...urlPins];
    setThreads((prev) => [t, ...prev]);
    setActiveId(t.id);
    setDraft("");
    setView("chat");
    patchQuery({ thread: t.id, view: null });
  }, [patchQuery, urlPins]);

  const changeView = useCallback(
    (next: AgentViewMode) => {
      setView(next);
      patchQuery({ view: next === "chat" ? null : next });
    },
    [patchQuery],
  );

  const removePin = useCallback(
    (pin: AgentContextPin) => {
      setThreads((prev) =>
        prev.map((t) =>
          t.id === activeId
            ? {
                ...t,
                pins: t.pins.filter(
                  (p) => !(p.kind === pin.kind && p.id === pin.id),
                ),
              }
            : t,
        ),
      );
      const clear: Record<string, null> = {};
      if (pin.kind === "trace") clear.traceId = null;
      if (pin.kind === "issue") clear.issueId = null;
      if (pin.kind === "plan") clear.planId = null;
      if (pin.kind === "agent") clear.agent = null;
      patchQuery(clear);
    },
    [activeId, patchQuery],
  );

  const streamAssistantReply = useCallback(
    async (threadId: string, userText: string, pins: AgentContextPin[]) => {
      if (!orgId) {
        setThinking(false);
        pushToast({
          title: "No workspace selected",
          body: "Select a workspace to chat with the assistant.",
          tone: "fail",
        });
        return;
      }
      const assistantId = `a_${Date.now().toString(36)}`;
      let textSoFar = "";
      const citations: AgentCitation[] = [];
      const artifacts: AgentArtifact[] = [];
      let gotContent = false;

      const upsert = () => {
        const parts: AgentMessagePart[] = [
          { type: "text", text: textSoFar || "…" },
        ];
        if (citations.length > 0) parts.push({ type: "citations", items: [...citations] });
        if (artifacts.length > 0) parts.push({ type: "artifacts", items: [...artifacts] });
        setThreads((prev) =>
          prev.map((t) => {
            if (t.id !== threadId) return t;
            const exists = t.messages.some((m) => m.id === assistantId);
            const msg: AgentMessage = { id: assistantId, role: "assistant", at: "just now", parts };
            return {
              ...t,
              updatedAt: "just now",
              messages: exists
                ? t.messages.map((m) => (m.id === assistantId ? msg : m))
                : [...t.messages, msg],
            };
          }),
        );
      };

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // F41-4: routed through fetchApi's `raw` mode (still gets the
        // shared auth-bearer-attach + retry pipeline) instead of a
        // hand-rolled fetch() — `stream: true` skips the 30s default
        // timeout so a long AI response isn't cut off mid-stream, and
        // `raw: true` hands back the live, unread Response so we can
        // still attach our own SSE reader below.
        const res = await fetchApi<Response>(
          `/orgs/${encodeURIComponent(orgId)}/ai/chat`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              conversation_id: conversationIdsRef.current[threadId] ?? null,
              message: userText,
              page_context:
                pins.length > 0
                  ? { pins: pins.map((p) => ({ kind: p.kind, id: p.id, label: p.label })) }
                  : {},
            }),
            signal: controller.signal,
            stream: true,
            raw: true,
          },
        );

        if (!res.ok || !res.body) {
          throw new Error(`Assistant request failed (HTTP ${res.status}).`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            // PQ-3: bail the moment the user hits stop / switches
            // thread / unmounts. Without this the loop keeps decoding
            // and flushing already-buffered frames into a thread the
            // user has abandoned, and the half-drained body stays
            // open until GC gets around to it.
            if (controller.signal.aborted) break;
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const chunk = parseSseFrame(frame);
              if (!chunk) continue;
              if (chunk.type === "text_delta" && chunk.text) {
                textSoFar += chunk.text;
                gotContent = true;
                upsert();
              } else if (chunk.type === "citation" && chunk.citation) {
                citations.push(mapCitation(chunk.citation));
                gotContent = true;
                upsert();
              } else if (chunk.type === "chart" && chunk.chart) {
                const artifact = mapChart(chunk.chart);
                if (artifact) {
                  artifacts.push(artifact);
                  gotContent = true;
                  upsert();
                }
              } else if (chunk.type === "summary" || chunk.type === "connected") {
                if (chunk.conversation_id && chunk.conversation_id !== "new") {
                  conversationIdsRef.current[threadId] = chunk.conversation_id;
                }
              } else if (chunk.type === "error") {
                throw new Error(chunk.error || chunk.message || "Assistant error.");
              }
            }
          }
        } finally {
          // PQ-3: release the body on every exit path (abort, thrown
          // SSE error frame, early break) so the upstream connection
          // is torn down immediately rather than left billing.
          // No-op when the stream already ran to completion.
          await reader.cancel().catch(() => {});
        }

        // Breaking on the signal above means the loop can now finish
        // normally on abort, where it used to reject out of read().
        // Re-raise so the shared catch still renders the "Stopped."
        // affordance instead of falling through to a success render.
        if (controller.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        if (!gotContent) {
          textSoFar = "No response from the assistant.";
          upsert();
        }
      } catch (err) {
        if (controller.signal.aborted) {
          setThreads((prev) =>
            prev.map((t) =>
              t.id === threadId
                ? {
                    ...t,
                    updatedAt: "just now",
                    messages: t.messages.some((m) => m.id === assistantId)
                      ? t.messages
                      : [
                          ...t.messages,
                          {
                            id: `${assistantId}_stop`,
                            role: "assistant",
                            at: "just now",
                            parts: [{ type: "text", text: "Stopped. Send again when you’re ready." }],
                          },
                        ],
                  }
                : t,
            ),
          );
        } else {
          const message = err instanceof Error ? err.message : "Assistant request failed.";
          pushToast({ title: "Assistant error", body: message, tone: "fail" });
          setThreads((prev) =>
            prev.map((t) =>
              t.id === threadId
                ? {
                    ...t,
                    updatedAt: "just now",
                    messages: [
                      ...t.messages.filter((m) => m.id !== assistantId),
                      {
                        id: `${assistantId}_err`,
                        role: "assistant",
                        at: "just now",
                        parts: [{ type: "text", text: `Couldn’t reach the assistant: ${message}` }],
                      },
                    ],
                  }
                : t,
            ),
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setThinking(false);
        }
      }
    },
    [orgId, pushToast],
  );

  const appendExchange = useCallback(
    (userText: string) => {
      if (!activeId || thinking) return;
      const text = userText.trim();
      if (!text) return;
      if (!orgId) {
        pushToast({
          title: "No workspace selected",
          body: "Select a workspace to chat with the assistant.",
          tone: "fail",
        });
        return;
      }

      const userMsg: AgentMessage = {
        id: `u_${Date.now().toString(36)}`,
        role: "user",
        at: "just now",
        parts: [{ type: "text", text }],
      };

      const threadId = activeId;
      let pins: AgentContextPin[] = [];
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t;
          pins = t.pins;
          const title =
            t.messages.length === 0 ? titleFromPrompt(text) : t.title;
          return {
            ...t,
            title,
            updatedAt: "just now",
            messages: [...t.messages, userMsg],
          };
        }),
      );
      setDraft("");
      setView("chat");
      setThinking(true);
      void streamAssistantReply(threadId, text, pins);
    },
    [activeId, thinking, streamAssistantReply, orgId, pushToast],
  );

  const send = useCallback(() => {
    appendExchange(draft);
  }, [draft, appendExchange]);

  const suggest = useCallback(
    (prompt: string) => {
      appendExchange(prompt);
    },
    [appendExchange],
  );

  const stopThinking = useCallback(() => {
    abortRef.current?.abort();
    setThinking(false);
  }, []);

  // Seed composer from ?ai_prompt= — do not auto-send (avoids surprise
  // ReAct token burn from Traces "Open Assistant").
  useEffect(() => {
    if (!paramPrompt || seededPrompt === paramPrompt) return;
    setSeededPrompt(paramPrompt);
    setDraft(paramPrompt);
    patchQuery({ ai_prompt: null });
  }, [paramPrompt, seededPrompt, patchQuery]);

  // Threads history failing must not block a fresh chat — the boot
  // effect below seeds an empty thread when data is missing.

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Assistant"
        message="Select a workspace to chat with the assistant."
      />
    );
  }

  if (!active) {
    return (
      <div className="ds-page">
        <PageHeader title="Assistant" />
        {threadsQuery.isError ? (
          <div
            role="status"
            className="mx-5 mt-3 rounded-[var(--radius)] border border-[var(--warning)]/40 bg-[var(--warning-muted)] px-3 py-2 type-meta text-[var(--text)]"
          >
            Couldn’t load chat history. Starting a fresh conversation.
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => void threadsQuery.refetch()}
            >
              Retry
            </button>
          </div>
        ) : null}
        {threadsQuery.isLoading ? (
          <QueryLoadingPanel label="Opening chat…" />
        ) : (
          <p className="type-body px-5 py-8 text-[var(--text-secondary)]">
            Opening chat…
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Assistant"
        meta={
          <span className="type-meta">
            Product assistant · t3 · not the agent fleet
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <AgentModeNav value={view} onChange={changeView} />
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              onClick={startNew}
            >
              New chat
            </button>
          </div>
        }
      />

      {threadsQuery.isError ? (
        <div
          role="status"
          className="mx-5 mt-3 rounded-[var(--radius)] border border-[var(--warning)]/40 bg-[var(--warning-muted)] px-3 py-2 type-meta text-[var(--text)]"
        >
          Couldn’t load chat history. You can still start a new conversation.
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => void threadsQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <div
          className={
            view === "history"
              ? "flex min-h-0 flex-1 md:contents"
              : "hidden md:contents"
          }
        >
          <AgentHistoryRail
            threads={threads}
            activeId={active.id}
            query={historyQuery}
            onQueryChange={setHistoryQuery}
            onSelect={selectThread}
            onNew={startNew}
          />
        </div>

        <div
          className={
            view === "history"
              ? "hidden min-h-0 min-w-0 flex-1 md:flex"
              : "flex min-h-0 min-w-0 flex-1"
          }
        >
          <AgentChatStream
            thread={active}
            draft={draft}
            onDraftChange={setDraft}
            onSend={send}
            onSuggest={suggest}
            onRemovePin={removePin}
            thinking={thinking}
            onStop={stopThinking}
            composerRef={composerRef}
          />
        </div>
      </div>
    </div>
  );
}

export default function LabAgentPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Assistant" />
        </div>
      }
    >
      <LabAgentInner />
    </Suspense>
  );
}
