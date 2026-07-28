"use client";

import Link from "next/link";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  PanelLeftClose,
  X,
} from "lucide-react";
import {
  formatDuration,
  sortTracesNewestFirst,
  type TraceFixture,
  type TranscriptStep,
} from "@/lab/fixtures/traces";
import { agentForTrace } from "@/lab/fixtures/agents";
import { issueForTrace } from "@/lab/fixtures/issues";
import { signalsForTrace } from "@/lab/fixtures/signals";
import {
  agentForSession,
  sessionById as sessionByIdFixture,
  sessionForTrace,
  turnsForSession,
  type SessionFixture,
} from "@/lab/fixtures/sessions";
import { PageHeader } from "@/components/ds/primitives";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { SHELL_QUERY } from "@/lib/portal-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import {
  agentScopeCounts,
  groupByAgent,
  useAgentScope,
  useQueryPatch,
} from "@/lab/agent-scope";
import { useListKeyboard, usePersistentBool } from "@/lab/hooks";
import {
  AgentGroupHeader,
  AgentLink,
  AgentScopeFilter,
  EmptyState,
  errorStepIds,
  FilterChips,
  isBadStep,
  ListRevealButton,
  RunListButton,
  RunMeta,
  RunTranscript,
  SeverityBadge,
  stepKindLabel,
} from "@/lab/lab-ui";
import {
  HubViewToggle,
  parseHubView,
  SessionListButton,
  SessionReader,
  type HubView,
} from "@/lab/traces-session-lens";
import { cn } from "@/lib/utils";

type DetailTab = "trace" | "tree" | "signals" | "chat";
type SeverityFilter = "all" | "error" | "warn" | "ok";

function parseTab(value: string | null): DetailTab {
  if (
    value === "chat" ||
    value === "signals" ||
    value === "trace" ||
    value === "tree"
  ) {
    return value;
  }
  return "trace";
}

function TreePanel({
  steps,
  focusStepId,
  onFocus,
}: {
  steps: TranscriptStep[];
  focusStepId: string | null;
  onFocus: (id: string) => void;
}) {
  const byParent = useMemo(() => {
    const map = new Map<string | undefined, TranscriptStep[]>();
    for (const step of steps) {
      const key = step.parentId;
      const list = map.get(key) ?? [];
      list.push(step);
      map.set(key, list);
    }
    return map;
  }, [steps]);

  const roots = byParent.get(undefined) ?? steps.filter((s) => !s.parentId);

  function renderNode(step: TranscriptStep, depth: number) {
    const kids = byParent.get(step.spanId ?? step.id) ?? [];
    const bad = isBadStep(step);
    const active = focusStepId === step.id;
    return (
      <li key={step.id}>
        <button
          type="button"
          onClick={() => onFocus(step.id)}
          className={cn(
            "flex w-full items-center gap-2 py-2.5 pr-4 text-left transition-colors hover:bg-[var(--bg-hover)]",
            active && "bg-[var(--accent-muted)] shadow-[inset_2px_0_0_var(--accent)]",
            bad && !active && "bg-[var(--error-muted)]",
            bad && active && "shadow-[inset_2px_0_0_var(--error)]",
          )}
          style={{ paddingLeft: `${0.75 + depth * 1.1}rem` }}
        >
          <span className="ds-chip shrink-0 border border-[var(--line)] text-[var(--text-muted)]">
            {stepKindLabel(step.kind)}
          </span>
          <span
            className={cn(
              "type-ui min-w-0 flex-1 truncate !font-normal",
              bad ? "text-[var(--error)]" : "text-[var(--text)]",
            )}
          >
            {step.title}
          </span>
          <span className="type-value shrink-0 tabular-nums !text-[0.6875rem]">
            {formatDuration(step.durationMs)}
          </span>
        </button>
        {kids.length > 0 ? (
          <ul>{kids.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  }

  if (roots.length === 0) {
    return <EmptyState title="No spans" />;
  }

  return (
    <ul className="min-h-0 flex-1 overflow-y-auto py-1">
      {roots.map((step) => renderNode(step, 0))}
    </ul>
  );
}

function SignalsPanel({
  trace,
  onJumpStep,
  dismissed,
  onDismiss,
  onRestore,
}: {
  trace: TraceFixture;
  onJumpStep: (stepId: string) => void;
  dismissed: boolean;
  onDismiss: () => void;
  onRestore: () => void;
}) {
  const detectors = signalsForTrace(trace.id);
  const badSteps = trace.steps.filter(isBadStep);
  const empty = trace.severity === "none";

  if (empty) {
    return <EmptyState title="No signals" />;
  }

  if (dismissed) {
    return (
      <EmptyState
        title="Signals dismissed"
        action={
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onRestore}
          >
            Show
          </button>
        }
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={trace.severity} />
            <p className="type-ui text-[var(--text)]">{trace.signals.title}</p>
          </div>
          <p className="type-body mt-2 text-[var(--text-secondary)]">
            {trace.signals.body}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {badSteps.length > 0 ? (
        <section className="space-y-2">
          <h3 className="type-label">Failing spans</h3>
          <ul className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {badSteps.map((step) => (
              <li key={step.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 py-3 text-left hover:bg-[var(--accent-muted)]"
                  onClick={() => onJumpStep(step.id)}
                >
                  <SeverityBadge severity="error" />
                  <div className="min-w-0 flex-1">
                    <p className="type-ui truncate text-[var(--text)]">
                      {step.title}
                    </p>
                    <p className="type-meta mt-0.5 truncate">
                      {step.errorMessage ?? step.outputPreview ?? step.id}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detectors.length > 0 ? (
        <section className="space-y-2">
          <h3 className="type-label">Matched detectors</h3>
          <ul className="space-y-1">
            {detectors.map((sig) => (
              <li key={sig.id}>
                <Link
                  href={`/signals?id=${sig.id}`}
                  className="block px-1 py-2.5 transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <p className="type-ui text-[var(--text)]">{sig.name}</p>
                  <p className="type-mono mt-1 !text-[0.6875rem] !text-[var(--text-secondary)]">
                    {sig.condition}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ChatPanel({ trace }: { trace: TraceFixture }) {
  const issue = issueForTrace(trace.id);
  const bad = trace.steps.find(isBadStep);
  const agentHref = (() => {
    const q = new URLSearchParams();
    q.set("thread", "thr_empty");
    q.set("traceId", trace.id);
    q.set("agent", trace.agentId);
    if (issue) q.set("issueId", issue.id);
    return `/agent?${q.toString()}`;
  })();
  const [messages, setMessages] = useState<
    { role: "user" | "assistant"; text: string }[]
  >([
    {
      role: "assistant",
      text:
        trace.severity === "none"
          ? `${trace.name} — clean run.`
          : `${trace.signals.title}`,
    },
  ]);
  const [draft, setDraft] = useState("");

  function send() {
    const text = draft.trim();
    if (!text) return;
    const lower = text.toLowerCase();
    let reply = trace.signals.body;
    if (lower.includes("fix") && issue) {
      reply = issue.suggestedFix;
    } else if (lower.includes("fail") || lower.includes("error")) {
      reply = bad
        ? `${bad.title}: ${bad.errorMessage ?? bad.outputPreview ?? "failed"}`
        : trace.signals.body;
    } else if (lower.includes("cost") || lower.includes("token")) {
      reply = `${trace.tokens.toLocaleString()} tokens · $${trace.costUsd.toFixed(3)} · ${trace.durationMs}ms`;
    }
    setMessages((m) => [
      ...m,
      { role: "user", text },
      { role: "assistant", text: reply },
    ]);
    setDraft("");
  }

  function openInAgent() {
    const text = draft.trim();
    const q = new URLSearchParams();
    q.set("thread", "thr_empty");
    q.set("traceId", trace.id);
    q.set("agent", trace.agentId);
    if (issue) q.set("issueId", issue.id);
    if (text) q.set("ai_prompt", text);
    window.location.href = `/agent?${q.toString()}`;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2 sm:px-5">
        <p className="type-meta">Quick ask on this run</p>
        <Link href={agentHref} className="ds-btn ds-btn-ghost ds-btn-sm">
          Open Assistant
        </Link>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5">
        {messages.map((m, i) => (
          <div
            key={`${m.role}-${i}`}
            className={cn(
              "type-body max-w-[92%] px-3.5 py-2.5",
              m.role === "user"
                ? "ml-auto bg-[var(--accent-muted)] !text-[var(--text)]"
                : "border border-[var(--line)]",
            )}
          >
            {m.text}
          </div>
        ))}
      </div>
      <div className="flex gap-2 border-t border-[var(--line)] p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="Ask…"
          className="ds-input min-w-0 flex-1"
          aria-label="Ask about this run"
        />
        <button
          type="button"
          onClick={send}
          className="ds-btn ds-btn-primary ds-btn-sm"
        >
          Send
        </button>
        <button
          type="button"
          onClick={openInAgent}
          className="ds-btn ds-btn-outline ds-btn-sm"
          title="Continue in Assistant with this trace pinned"
        >
          Assistant
        </button>
      </div>
    </div>
  );
}

function LabTracesInner() {
  const searchParams = useSearchParams();
  const paramId = searchParams.get("id");
  const paramTab = searchParams.get("tab");
  const paramSpan = searchParams.get("span");
  const paramView = searchParams.get("view");
  const paramSession = searchParams.get("session");
  const { agentId, agent: scopeAgent, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const tracesQuery = useOrgQuery(
    queryKeys.portal.traces(orgId),
    orgId,
    () => portalApi.traces(orgId!),
    SHELL_QUERY,
  );
  // Keep agent filter options live — catalog singleton alone does not
  // re-render this page when PortalCatalogSync patches agents.
  const agentsQuery = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    SHELL_QUERY,
  );
  const sessionsQuery = useOrgQuery(
    queryKeys.portal.sessions(orgId),
    orgId,
    () => portalApi.sessions(orgId!),
    SHELL_QUERY,
  );
  const traces = tracesQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  void agentsQuery.data;

  const [listOpen, setListOpen, , listAnimate] = usePersistentBool(
    "eden.traces.listOpen",
    true,
  );
  const [hubView, setHubViewState] = useState<HubView>(() =>
    parseHubView(paramView),
  );
  const [selectedId, setSelectedId] = useState(
    () => traces.find((t) => t.id === paramId)?.id ?? traces[0]?.id ?? "",
  );
  // Set synchronously by `selectTrace` the instant a manual click picks
  // a row, and cleared once the URL-sync effect below observes
  // `paramId` has actually caught up to that click. `patchQuery`'s
  // `router.replace` (agent-scope.ts) resolves asynchronously, so
  // there's a gap where `selectedId` already points at the clicked row
  // but `paramId` still reflects the previous one. If something
  // unrelated to the click (e.g. PortalCatalogSync refetching the same
  // query key) hands `traces` a new array reference during that gap,
  // the effect re-fires with a `paramId` that's stale relative to the
  // click — this ref is how it tells "a click is in flight, don't
  // trust `paramId` yet" apart from "the URL and the data genuinely
  // disagree and the selection should follow the URL".
  const justSelectedTraceIdRef = useRef<string | null>(null);
  // Phase 2a — the list payload always has `steps: []` (avoids an
  // N+1 of per-trace span hydration); fetch the real transcript for
  // just the selected trace and merge it in below.
  const traceDetailQuery = useOrgQuery(
    queryKeys.portal.traceDetail(orgId, selectedId || null),
    orgId,
    () => portalApi.traceDetail(orgId!, selectedId),
    {
      ...SHELL_QUERY,
      staleTime: 30_000,
      enabled: Boolean(orgId) && Boolean(selectedId),
    },
  );
  const [selectedSessionId, setSelectedSessionId] = useState(
    () =>
      sessions.find((s) => s.id === paramSession)?.id ??
      sessions[0]?.id ??
      "",
  );
  // Same purpose as `justSelectedTraceIdRef` above, mirrored for
  // `selectSession` / `?session=`.
  const justSelectedSessionIdRef = useRef<string | null>(null);
  const [tab, setTab] = useState<DetailTab>(() => parseTab(paramTab));
  const [query, setQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [signalsDismissed, setSignalsDismissed] = useState(false);
  const [focusStepId, setFocusStepId] = useState<string | null>(paramSpan);
  const [copied, setCopied] = useState(false);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setHubViewState(parseHubView(paramView));
    const nextId = traces.find((t) => t.id === paramId)?.id;
    if (nextId) setSelectedId(nextId);
    const nextSession = sessions.find((s) => s.id === paramSession)?.id;
    if (nextSession) setSelectedSessionId(nextSession);
    if (paramTab) setTab(parseTab(paramTab));
    if (paramSpan) setFocusStepId(paramSpan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramId, paramTab, paramSpan, paramView, paramSession]);

  useEffect(() => {
    setSignalsDismissed(false);
    setOpenIds(new Set());
    if (!paramSpan) {
      setFocusStepId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, paramSpan]);

  // Real steps arrive async (separate detail fetch) — once they land
  // for the currently-selected trace, default-open/focus the first
  // failing span (mirrors the old synchronous-fixture behavior).
  useEffect(() => {
    const detail = traceDetailQuery.data;
    if (!detail || detail.id !== selectedId) return;
    const defaults = errorStepIds(detail.steps);
    setOpenIds(new Set(defaults));
    if (!paramSpan) {
      setFocusStepId(defaults[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceDetailQuery.data, selectedId, paramSpan]);

  // Default selections once live rows arrive (initial state above can't
  // reach into query data that hasn't resolved yet) — and re-sync
  // whenever `traces` catches up with `paramId`. Without `paramId` in
  // the deps, this only fired on `traces` changing: if `?id=` pointed
  // at a run that wasn't in `traces` yet (e.g. selection defaulted to
  // `traces[0]` while the target was still loading), `selectedId`
  // stayed truthy forever and the old guard (`if (selectedId || ...)
  // return`) meant the effect never revisited it once the real row
  // did arrive — the selection went stale relative to the URL.
  // `selectedId` itself is read but deliberately left out of the deps
  // — but that alone does NOT avoid the manual-click race: `traces`
  // (this effect's other dep) can get a new array reference from a
  // source completely unrelated to the click (e.g. PortalCatalogSync
  // refetching the same query key), which re-fires this effect while
  // `paramId` still lags a just-made `selectTrace` pick (its
  // `patchQuery` → `router.replace` resolves asynchronously). That
  // would otherwise see `matched !== selectedId` and stomp the fresh
  // click back to the previous row. `justSelectedTraceIdRef` is the
  // actual guard against that: while a click is in flight and `paramId`
  // hasn't caught up to it yet, this effect defers instead of
  // reconciling against the stale param; once `paramId` does match the
  // click, the ref clears and normal reconciliation (the staleness fix
  // above) resumes.
  useEffect(() => {
    if (traces.length === 0) return;
    if (justSelectedTraceIdRef.current !== null) {
      if (paramId === justSelectedTraceIdRef.current) {
        justSelectedTraceIdRef.current = null;
      } else {
        return;
      }
    }
    const matched = traces.find((t) => t.id === paramId)?.id;
    if (matched) {
      if (matched !== selectedId) setSelectedId(matched);
      return;
    }
    if (!selectedId) {
      const next = traces[0]?.id;
      if (next) setSelectedId(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traces, paramId]);
  // Same fix, mirrored for sessions (`selectedSessionId` vs. `?session=`).
  useEffect(() => {
    if (sessions.length === 0) return;
    if (justSelectedSessionIdRef.current !== null) {
      if (paramSession === justSelectedSessionIdRef.current) {
        justSelectedSessionIdRef.current = null;
      } else {
        return;
      }
    }
    const matched = sessions.find((s) => s.id === paramSession)?.id;
    if (matched) {
      if (matched !== selectedSessionId) setSelectedSessionId(matched);
      return;
    }
    if (!selectedSessionId) {
      const next = sessions[0]?.id;
      if (next) setSelectedSessionId(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, paramSession]);

  const setHubView = useCallback(
    (next: HubView) => {
      setHubViewState(next);
      setQuery("");
      setSeverityFilter("all");
      if (next === "runs") {
        patchQuery({
          view: null,
          session: null,
          id: selectedId,
          tab: null,
          span: null,
        });
      } else {
        const sessionId =
          selectedSessionId ||
          sessionForTrace(selectedId)?.id ||
          sessions[0]?.id ||
          null;
        if (sessionId) setSelectedSessionId(sessionId);
        patchQuery({
          view: "sessions",
          session: sessionId,
          id: null,
          tab: null,
          span: null,
        });
      }
    },
    [patchQuery, selectedId, selectedSessionId],
  );

  const selectTrace = useCallback(
    (id: string, nextTab?: DetailTab) => {
      justSelectedTraceIdRef.current = id;
      setSelectedId(id);
      const resolvedTab = nextTab ?? tab;
      setTab(resolvedTab);
      const sess = sessionForTrace(id);
      if (hubView === "sessions" && sess) {
        setSelectedSessionId(sess.id);
        patchQuery({
          view: "sessions",
          session: sess.id,
          id,
          tab: resolvedTab === "trace" ? null : resolvedTab,
          span: null,
        });
      } else {
        patchQuery({
          id,
          tab: resolvedTab === "trace" ? null : resolvedTab,
          span: null,
        });
      }
    },
    [patchQuery, tab, hubView],
  );

  const selectSession = useCallback(
    (id: string) => {
      justSelectedSessionIdRef.current = id;
      setSelectedSessionId(id);
      patchQuery({
        view: "sessions",
        session: id,
        id: null,
        tab: null,
        span: null,
      });
    },
    [patchQuery],
  );

  const openTurn = useCallback(
    (traceId: string) => {
      justSelectedTraceIdRef.current = traceId;
      setSelectedId(traceId);
      setTab("trace");
      patchQuery({
        view: "sessions",
        session: selectedSessionId,
        id: traceId,
        tab: null,
        span: null,
      });
    },
    [patchQuery, selectedSessionId],
  );

  const backToSession = useCallback(() => {
    patchQuery({
      view: "sessions",
      session: selectedSessionId,
      id: null,
      tab: null,
      span: null,
    });
  }, [patchQuery, selectedSessionId]);

  const focusStep = useCallback(
    (stepId: string) => {
      setFocusStepId(stepId);
      setTab("trace");
      patchQuery({ tab: null, span: stepId });
    },
    [patchQuery],
  );

  const focusStepInPlace = useCallback(
    (stepId: string) => {
      setFocusStepId(stepId);
      patchQuery({ span: stepId });
    },
    [patchQuery],
  );

  const scopedTraces = useMemo(() => {
    const base =
      agentId === "all"
        ? traces
        : traces.filter((t) => t.agentId === agentId);
    return sortTracesNewestFirst(base);
  }, [agentId, traces]);

  const scopedSessions = useMemo(() => {
    const base =
      agentId === "all"
        ? sessions
        : sessions.filter((s) => s.agentId === agentId);
    return base;
  }, [agentId, sessions]);

  const agentCounts = useMemo(() => agentScopeCounts(traces), [traces]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scopedTraces.filter((t) => {
      if (severityFilter === "error" && t.severity !== "error") return false;
      if (severityFilter === "warn" && t.severity !== "warn") return false;
      if (severityFilter === "ok" && t.severity !== "none") return false;
      if (!q) return true;
      const agent = agentForTrace(t);
      return (
        t.name.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.signals.title.toLowerCase().includes(q) ||
        (agent?.name.toLowerCase().includes(q) ?? false)
      );
    });
  }, [scopedTraces, query, severityFilter]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scopedSessions.filter((s) => {
      if (severityFilter === "error" && s.outcome !== "error") return false;
      if (severityFilter === "warn" && s.outcome !== "mixed") return false;
      if (severityFilter === "ok" && s.outcome !== "ok") return false;
      if (!q) return true;
      const agent = agentForSession(s);
      return (
        s.id.toLowerCase().includes(q) ||
        (s.diagnosis?.toLowerCase().includes(q) ?? false) ||
        (s.lastErrorSummary?.toLowerCase().includes(q) ?? false) ||
        (agent?.name.toLowerCase().includes(q) ?? false)
      );
    });
  }, [scopedSessions, query, severityFilter]);

  const groups = useMemo(() => groupByAgent(filtered), [filtered]);

  const selectedListItem =
    filtered.find((t) => t.id === selectedId) ??
    scopedTraces.find((t) => t.id === selectedId) ??
    filtered[0] ??
    scopedTraces[0];

  // Merge in the real transcript once the detail fetch for this
  // trace resolves; falls back to the list row's `steps: []` while
  // loading (or if the detail fetch fails) so the rest of the page
  // never has to special-case a missing trace.
  const selected = useMemo(() => {
    if (!selectedListItem) return selectedListItem;
    const detail = traceDetailQuery.data;
    if (detail && detail.id === selectedListItem.id) {
      return { ...selectedListItem, steps: detail.steps };
    }
    return selectedListItem;
  }, [selectedListItem, traceDetailQuery.data]);

  const selectedSession: SessionFixture | undefined =
    filteredSessions.find((s) => s.id === selectedSessionId) ??
    sessionByIdFixture(selectedSessionId) ??
    filteredSessions[0];

  const inspectingTurn =
    hubView === "sessions" &&
    Boolean(paramId) &&
    Boolean(selectedSession?.traceIds.includes(selectedId));

  const selectedIndex =
    hubView === "sessions"
      ? selectedSession
        ? filteredSessions.findIndex((s) => s.id === selectedSession.id)
        : -1
      : selected
        ? filtered.findIndex((t) => t.id === selected.id)
        : -1;

  useEffect(() => {
    if (hubView !== "runs") return;
    if (!selected) return;
    if (!filtered.some((t) => t.id === selected.id) && filtered[0]) {
      selectTrace(filtered[0].id, "trace");
    }
  }, [hubView, filtered, selected, selectTrace]);

  // Neighbor prefetch intentionally omitted — each detail hit is a
  // get_trace_tree call; Newer/Older pay one fetch on demand.

  useEffect(() => {
    if (hubView !== "sessions") return;
    if (!selectedSession) return;
    if (
      !filteredSessions.some((s) => s.id === selectedSession.id) &&
      filteredSessions[0]
    ) {
      selectSession(filteredSessions[0].id);
    }
  }, [hubView, filteredSessions, selectedSession, selectSession]);

  const selectRelative = useCallback(
    (delta: number) => {
      if (hubView === "sessions") {
        if (!filteredSessions.length) return;
        const idx = selectedIndex < 0 ? 0 : selectedIndex;
        const next =
          filteredSessions[
            Math.min(filteredSessions.length - 1, Math.max(0, idx + delta))
          ];
        if (next) selectSession(next.id);
        return;
      }
      if (!filtered.length) return;
      const idx = selectedIndex < 0 ? 0 : selectedIndex;
      const next =
        filtered[Math.min(filtered.length - 1, Math.max(0, idx + delta))];
      if (next) selectTrace(next.id);
    },
    [
      hubView,
      filtered,
      filteredSessions,
      selectedIndex,
      selectTrace,
      selectSession,
    ],
  );

  const setDetailTab = useCallback(
    (next: DetailTab) => {
      setTab(next);
      patchQuery({ tab: next === "trace" ? null : next });
    },
    [patchQuery],
  );

  useListKeyboard({
    move: selectRelative,
    onTab:
      hubView === "runs" || inspectingTurn
        ? (t) => {
            if (t === "trace" || t === "signals" || t === "chat") setDetailTab(t);
          }
        : undefined,
  });

  useEffect(() => {
    if (hubView === "sessions" && !inspectingTurn && selectedSession) {
      document
        .querySelector(`[data-session-id="${selectedSession.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (!selected) return;
    document
      .querySelector(`[data-run-id="${selected.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [hubView, inspectingTurn, selected?.id, selectedSession?.id]);

  const agent = selected ? agentForTrace(selected) : undefined;
  const issue = selected ? issueForTrace(selected.id) : undefined;
  const session = selected ? sessionForTrace(selected.id) : undefined;
  const sessionTurns = session ? turnsForSession(session) : [];
  const badStepIds = selected ? errorStepIds(selected.steps) : [];
  const signalCount =
    selected?.signals.count ?? (selected?.severity === "none" ? 0 : 1);

  const severityCounts = useMemo(() => {
    if (hubView === "sessions") {
      return {
        all: scopedSessions.length,
        error: scopedSessions.filter((s) => s.outcome === "error").length,
        warn: scopedSessions.filter((s) => s.outcome === "mixed").length,
        ok: scopedSessions.filter((s) => s.outcome === "ok").length,
      };
    }
    return {
      all: scopedTraces.length,
      error: scopedTraces.filter((t) => t.severity === "error").length,
      warn: scopedTraces.filter((t) => t.severity === "warn").length,
      ok: scopedTraces.filter((t) => t.severity === "none").length,
    };
  }, [hubView, scopedTraces, scopedSessions]);

  const feedCount =
    hubView === "sessions" ? filteredSessions.length : filtered.length;
  const feedTotal =
    hubView === "sessions" ? scopedSessions.length : scopedTraces.length;
  const canNewer = selectedIndex > 0;
  const canOlder =
    selectedIndex >= 0 && selectedIndex < feedCount - 1;
  const turnIndex = selected
    ? sessionTurns.findIndex((t) => t.trace.id === selected.id)
    : -1;

  async function copyId() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  const showRunInspector =
    hubView === "runs" ? Boolean(selected) : inspectingTurn && Boolean(selected);

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Traces"
        message="Select a workspace to view traces."
      />
    );
  }

  if (tracesQuery.isLoading || sessionsQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Traces" />
        <QueryLoadingPanel label="Loading traces…" />
      </div>
    );
  }

  if (tracesQuery.isError || sessionsQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Traces" />
        <QueryErrorPanel
          error={tracesQuery.error ?? sessionsQuery.error}
          onRetry={() => {
            void tracesQuery.refetch();
            void sessionsQuery.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Traces"
        meta={
          <span className="type-meta">
            {scopeAgent ? scopeAgent.name : "All agents"} · {feedCount}
            {feedCount !== feedTotal ? ` of ${feedTotal}` : ""}{" "}
            {hubView === "sessions" ? "sessions" : "runs"}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <HubViewToggle value={hubView} onChange={setHubView} />
            {!listOpen ? (
              <ListRevealButton
                label="Feed"
                onClick={() => setListOpen(true)}
              />
            ) : null}
          </div>
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          className={cn(
            "flex min-h-0 shrink-0 flex-col overflow-hidden border-[var(--line)] bg-[var(--bg-inset)]",
            listAnimate && "transition-[width,opacity] duration-200 ease-out",
            listOpen
              ? "w-[min(17.5rem,36vw)] border-r opacity-100"
              : "pointer-events-none w-0 border-r-0 opacity-0",
          )}
          aria-hidden={!listOpen}
        >
          <div className="lab-list-chrome !gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="type-ui text-[var(--text)]">
                {hubView === "sessions" ? "Sessions" : "Feed"}
                <span className="type-mono ml-2 tabular-nums !text-[var(--text-muted)]">
                  {selectedIndex >= 0 ? selectedIndex + 1 : 0}/{feedCount}
                </span>
              </p>
              <button
                type="button"
                onClick={() => setListOpen(false)}
                className="ds-btn ds-btn-ghost ds-btn-icon"
                aria-label="Collapse list"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>
            <AgentScopeFilter
              value={agentId}
              onChange={setAgentId}
              counts={agentCounts}
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="ds-input w-full"
              aria-label={
                hubView === "sessions" ? "Filter sessions" : "Filter traces"
              }
            />
            <FilterChips
              value={severityFilter}
              onChange={setSeverityFilter}
              scroll
              options={[
                { id: "all", label: "All", count: severityCounts.all },
                { id: "error", label: "Fail", count: severityCounts.error },
                { id: "warn", label: "Warn", count: severityCounts.warn },
                { id: "ok", label: "Ok", count: severityCounts.ok },
              ]}
            />
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {hubView === "sessions" ? (
              filteredSessions.length === 0 ? (
                <li>
                  <EmptyState
                    title={
                      query
                        ? `No matches for “${query}”`
                        : scopeAgent
                          ? `No sessions for ${scopeAgent.name}`
                          : "No matching sessions"
                    }
                  />
                </li>
              ) : (
                filteredSessions.map((s) => (
                  <li key={s.id}>
                    <SessionListButton
                      session={s}
                      active={s.id === selectedSession?.id}
                      onSelect={() => selectSession(s.id)}
                    />
                  </li>
                ))
              )
            ) : filtered.length === 0 ? (
              <li>
                <EmptyState
                  title={
                    query
                      ? `No matches for “${query}”`
                      : scopeAgent
                        ? `No runs for ${scopeAgent.name}`
                        : "No matching runs"
                  }
                />
              </li>
            ) : agentId === "all" ? (
              groups.length > 0 ? (
              groups.map((group) => (
                <li key={group.agent.id}>
                  <AgentGroupHeader
                    agent={group.agent}
                    count={group.items.length}
                    href={`/agents?id=${group.agent.id}`}
                  />
                  <ul>
                    {group.items.map((t) => (
                      <li key={t.id}>
                        <RunListButton
                          trace={t}
                          active={t.id === selected?.id}
                          showAgent={false}
                          onSelect={() => selectTrace(t.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))
              ) : (
                filtered.map((t) => (
                  <li key={t.id}>
                    <RunListButton
                      trace={t}
                      active={t.id === selected?.id}
                      showAgent
                      onSelect={() => selectTrace(t.id)}
                    />
                  </li>
                ))
              )
            ) : (
              filtered.map((t) => (
                <li key={t.id}>
                  <RunListButton
                    trace={t}
                    active={t.id === selected?.id}
                    showAgent={false}
                    onSelect={() => selectTrace(t.id)}
                  />
                </li>
              ))
            )}
          </ul>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]">
          {hubView === "sessions" && selectedSession && !inspectingTurn ? (
            <SessionReader
              session={selectedSession}
              onOpenTurn={openTurn}
            />
          ) : showRunInspector && selected ? (
            <>
              <header className="shrink-0 border-b border-[var(--line)] px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={selected.severity} />
                      <h2 className="type-ui min-w-0 truncate text-[var(--text)]">
                        {selected.name}
                      </h2>
                    </div>
                    <p className="type-meta mt-1.5 truncate">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-[var(--text)]"
                        onClick={() => void copyId()}
                        title="Copy run id"
                      >
                        {selected.id}
                        <Copy className="h-3 w-3 opacity-50" aria-hidden />
                        {copied ? (
                          <span className="text-[var(--accent)]">copied</span>
                        ) : null}
                      </button>
                      {" · "}
                      {selected.startedAt}
                      {" · "}
                      <AgentLink
                        agentId={agent?.id}
                        name={agent?.name ?? "unknown agent"}
                      />
                    </p>
                    <div className="mt-1.5">
                      <RunMeta trace={selected} />
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {hubView === "sessions" ? (
                      <button
                        type="button"
                        className="ds-btn ds-btn-ghost ds-btn-sm"
                        onClick={backToSession}
                      >
                        Session
                      </button>
                    ) : (
                      <>
                        {(() => {
                          const sess = sessionForTrace(selected.id);
                          return sess ? (
                            <Link
                              href={`/traces?view=sessions&session=${sess.id}&id=${selected.id}&agent=${selected.agentId}`}
                              className="ds-btn ds-btn-ghost ds-btn-sm"
                            >
                              Session
                            </Link>
                          ) : null;
                        })()}
                        <div
                          className="flex items-center"
                          role="group"
                          aria-label="Move through feed"
                        >
                          <button
                            type="button"
                            className="ds-btn ds-btn-ghost ds-btn-sm"
                            disabled={!canNewer}
                            onClick={() => selectRelative(-1)}
                            aria-label="Newer run"
                            title="Newer run"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                            Newer
                          </button>
                          <button
                            type="button"
                            className="ds-btn ds-btn-ghost ds-btn-sm"
                            disabled={!canOlder}
                            onClick={() => selectRelative(1)}
                            aria-label="Older run"
                            title="Older run"
                          >
                            Older
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </>
                    )}
                    {sessionTurns.length > 1 && turnIndex >= 0 ? (
                      <div
                        className="flex items-center gap-0.5 border-l border-[var(--line)] pl-1.5"
                        role="group"
                        aria-label="Session turns"
                      >
                        <span className="type-meta px-1 tabular-nums">
                          {turnIndex + 1}/{sessionTurns.length}
                        </span>
                        <button
                          type="button"
                          className="ds-btn ds-btn-ghost ds-btn-icon"
                          disabled={turnIndex <= 0}
                          onClick={() =>
                            selectTrace(sessionTurns[turnIndex - 1].trace.id)
                          }
                          aria-label="Previous turn"
                          title="Previous turn"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          className="ds-btn ds-btn-ghost ds-btn-icon"
                          disabled={turnIndex >= sessionTurns.length - 1}
                          onClick={() =>
                            selectTrace(sessionTurns[turnIndex + 1].trace.id)
                          }
                          aria-label="Next turn"
                          title="Next turn"
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : null}
                    {badStepIds[0] ? (
                      <button
                        type="button"
                        className="ds-btn ds-btn-ghost ds-btn-sm"
                        onClick={() => focusStep(badStepIds[0])}
                      >
                        Fail
                      </button>
                    ) : null}
                    {issue ? (
                      <Link
                        href={`/issues?id=${issue.id}&agent=${issue.agentId}`}
                        className="ds-btn ds-btn-primary ds-btn-sm"
                      >
                        Open issue
                      </Link>
                    ) : null}
                    {issue || selected.severity === "error" || selected.severity === "warn" ? (
                      <Link
                        href={
                          issue
                            ? `/improve?issue=${issue.id}&agent=${selected.agentId}`
                            : `/improve?agent=${selected.agentId}`
                        }
                        className="ds-btn ds-btn-ghost ds-btn-sm"
                      >
                        Improve
                      </Link>
                    ) : null}
                    <Link
                      href={`/debugger?traceId=${selected.id}&agent=${selected.agentId}`}
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                    >
                      Debugger
                    </Link>
                    <Link
                      href={`/evals?mode=datasets&from=${selected.id}&agent=${selected.agentId}`}
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                    >
                      Dataset
                    </Link>
                    <Link
                      href={`/agent?thread=thr_empty&traceId=${selected.id}&agent=${selected.agentId}${
                        issue ? `&issueId=${issue.id}` : ""
                      }`}
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                    >
                      Ask AI
                    </Link>
                  </div>
                </div>
              </header>

              <div
                role="tablist"
                aria-label="Trace detail"
                className="flex shrink-0 items-center gap-1 border-b border-[var(--line)] px-4 py-1.5 sm:px-5"
              >
                {(
                  [
                    ["trace", "Transcript"],
                    [
                      "signals",
                      signalCount > 0 ? `Signals · ${signalCount}` : "Signals",
                    ],
                    ["tree", "Tree"],
                    ["chat", "Ask"],
                  ] as const
                ).map(([id, label], i) => (
                  <span key={id} className="contents">
                    {i === 2 ? (
                      <span
                        className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]"
                        aria-hidden
                      />
                    ) : null}
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === id}
                      onClick={() => setDetailTab(id)}
                      className={cn(
                        "ds-tab",
                        id === "signals" &&
                          signalCount > 0 &&
                          selected.severity !== "none" &&
                          tab !== id &&
                          "!text-[var(--accent)]",
                      )}
                    >
                      {label}
                    </button>
                  </span>
                ))}
                {tab === "trace" ? (
                  <div className="ml-auto flex items-center gap-1">
                    <span className="type-label mr-1 hidden sm:inline">
                      {selected.steps.length} spans
                    </span>
                    <button
                      type="button"
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                      onClick={() =>
                        setOpenIds(new Set(selected.steps.map((s) => s.id)))
                      }
                    >
                      Expand
                    </button>
                    <button
                      type="button"
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                      onClick={() => setOpenIds(new Set())}
                    >
                      Collapse
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                {tab === "trace" ? (
                  <div className="min-h-0 h-full overflow-y-auto">
                    <RunTranscript
                      key={selected.id}
                      steps={selected.steps}
                      defaultOpenIds={badStepIds}
                      focusStepId={focusStepId}
                      hideToolbar
                      openIds={openIds}
                      onOpenIdsChange={setOpenIds}
                    />
                  </div>
                ) : null}
                {tab === "tree" ? (
                  <TreePanel
                    steps={selected.steps}
                    focusStepId={focusStepId}
                    onFocus={focusStepInPlace}
                  />
                ) : null}
                {tab === "signals" ? (
                  <SignalsPanel
                    trace={selected}
                    dismissed={signalsDismissed}
                    onDismiss={() => setSignalsDismissed(true)}
                    onRestore={() => setSignalsDismissed(false)}
                    onJumpStep={focusStep}
                  />
                ) : null}
                {tab === "chat" ? (
                  <ChatPanel key={selected.id} trace={selected} />
                ) : null}
              </div>
            </>
          ) : (
            <EmptyState
              title={
                hubView === "sessions" ? "No session selected" : "No run selected"
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function TracesClient() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader
            title="Traces"
            meta={<span className="type-meta">Loading…</span>}
          />
        </div>
      }
    >
      <LabTracesInner />
    </Suspense>
  );
}
