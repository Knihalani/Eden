"use client";

import Link from "next/link";
import {
  Fragment,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { measureVirtualRow, VIRTUAL_SCROLL_ATTR } from "@/lab/virtual-list";
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
import { issueForTrace, type IssueFixture } from "@/lab/fixtures/issues";
import { signalsForTrace } from "@/lab/fixtures/signals";
import {
  agentForSession,
  resolveSessionForTrace,
  sessionById as sessionByIdFixture,
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

type TreeRow = {
  step: TranscriptStep;
  depth: number;
  hasChildren: boolean;
};

/**
 * Depth-first flatten of the span tree. Virtualising needs a flat,
 * index-addressable list — a recursive JSX walk can only render the
 * whole tree at once. `seen` guards against a malformed payload whose
 * parent pointers form a cycle (the old recursion would hang).
 */
export function flattenSpanTree(steps: TranscriptStep[]): TreeRow[] {
  const byParent = new Map<string | undefined, TranscriptStep[]>();
  for (const step of steps) {
    const key = step.parentId;
    const list = byParent.get(key) ?? [];
    list.push(step);
    byParent.set(key, list);
  }
  const roots = byParent.get(undefined) ?? steps.filter((s) => !s.parentId);

  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (nodes: TranscriptStep[], depth: number) => {
    for (const step of nodes) {
      if (seen.has(step.id)) continue;
      seen.add(step.id);
      const kids = byParent.get(step.spanId ?? step.id) ?? [];
      out.push({ step, depth, hasChildren: kids.length > 0 });
      if (kids.length > 0) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  // Parents truncated by max_spans (or missing) used to drop orphans
  // entirely — Tree undercounted vs Transcript with no warning.
  const orphans = steps.filter((s) => !seen.has(s.id));
  if (orphans.length > 0) walk(orphans, 0);
  return out;
}

/** ~40px at the current density; real heights come from measureElement. */
const TREE_ROW_ESTIMATE = 40;

const TreeRowButton = memo(function TreeRowButton({
  step,
  depth,
  active,
  hasChildren,
  posInSet,
  setSize,
  onFocus,
}: {
  step: TranscriptStep;
  depth: number;
  active: boolean;
  hasChildren: boolean;
  posInSet: number;
  setSize: number;
  onFocus: (id: string) => void;
}) {
  const bad = isBadStep(step);
  const handleClick = useCallback(() => onFocus(step.id), [onFocus, step.id]);
  return (
    <button
      type="button"
      onClick={handleClick}
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-selected={active}
      aria-expanded={hasChildren ? true : undefined}
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
  );
});

function TreePanel({
  steps,
  focusStepId,
  onFocus,
}: {
  steps: TranscriptStep[];
  focusStepId: string | null;
  onFocus: (id: string) => void;
}) {
  const rows = useMemo(() => flattenSpanTree(steps), [steps]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index) => rows[index]?.step.id ?? index,
    measureElement: measureVirtualRow,
  });

  // Bring the focused span into view even when its row is not mounted.
  useEffect(() => {
    if (!focusStepId) return;
    const index = rows.findIndex((r) => r.step.id === focusStepId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [focusStepId, rows, virtualizer]);

  if (rows.length === 0) {
    return <EmptyState title="No spans" />;
  }

  return (
    <div
      ref={scrollRef}
      className="min-h-0 h-full overflow-y-auto py-1"
      {...{ [VIRTUAL_SCROLL_ATTR]: "tree" }}
    >
      <ul
        role="tree"
        aria-label="Span tree"
        className="relative"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <li
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              role="none"
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <TreeRowButton
                step={row.step}
                depth={row.depth}
                active={focusStepId === row.step.id}
                hasChildren={row.hasChildren}
                posInSet={item.index + 1}
                setSize={rows.length}
                onFocus={onFocus}
              />
            </li>
          );
        })}
      </ul>
    </div>
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
  // severity==="none" used to short-circuit to EmptyState even when
  // the API shipped a "Clean run" summary — so every successful trace
  // looked broken ("No signals").
  const empty =
    !trace.signals.title &&
    detectors.length === 0 &&
    badSteps.length === 0;

  if (empty) {
    return (
      <EmptyState
        title="No signals"
        body="No detectors matched and no failing spans on this run."
      />
    );
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
            <p className="type-ui text-[var(--text)]">
              {trace.signals.title ||
                (trace.severity === "none" ? "Clean run" : "Signals")}
            </p>
          </div>
          <p className="type-body mt-2 text-[var(--text-secondary)]">
            {trace.signals.body ||
              (badSteps.length > 0
                ? `${badSteps.length} failing span${badSteps.length === 1 ? "" : "s"}.`
                : "No detectors matched this run.")}
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

function ChatPanel({
  trace,
  issue,
}: {
  trace: TraceFixture;
  issue?: IssueFixture;
}) {
  const agentHref = (() => {
    const q = new URLSearchParams();
    q.set("thread", "thr_empty");
    q.set("traceId", trace.id);
    q.set("agent", trace.agentId);
    if (issue) q.set("issueId", issue.id);
    return `/agent?${q.toString()}`;
  })();
  const [draft, setDraft] = useState("");

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
        <p className="type-meta">Ask the assistant about this run</p>
        <Link href={agentHref} className="ds-btn ds-btn-ghost ds-btn-sm">
          Open Assistant
        </Link>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5">
        <p className="type-body text-[var(--text-secondary)]">
          {trace.signals.title
            ? `${trace.signals.title} — ${trace.signals.body || "Open the assistant to investigate."}`
            : `${trace.name} · ${trace.tokens.toLocaleString()} tokens · $${trace.costUsd.toFixed(4)}. Open the assistant for a real answer.`}
        </p>
      </div>
      <div className="flex shrink-0 gap-2 border-t border-[var(--line)] px-4 py-3 sm:px-5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openInAgent();
          }}
          placeholder="Ask about this run…"
          className="ds-input min-w-0 flex-1"
          aria-label="Ask about this run"
        />
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm shrink-0"
          onClick={openInAgent}
        >
          Ask
        </button>
      </div>
    </div>
  );
}

/** Flat row model for the virtualised feed (sessions / grouped / flat runs). */
type FeedRow =
  | {
      kind: "group";
      key: string;
      agent: { id: string; name: string };
      count: number;
    }
  | {
      kind: "run";
      key: string;
      trace: TraceFixture;
      showAgent: boolean;
      pos: number;
    }
  | { kind: "session"; key: string; session: SessionFixture; pos: number };

/** `.lab-run-row` at current density; corrected by `measureElement`. */
const FEED_ROW_ESTIMATE = 65;
const FEED_GROUP_ESTIMATE = 55;

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

  // Subscribe to issues so Open issue / Ask issueId re-render when the
  // catalog sibling finishes — reading catalogIssues() alone does not.
  const issuesQuery = useOrgQuery(
    queryKeys.portal.issues(orgId),
    orgId,
    () => portalApi.issues(orgId!),
    SHELL_QUERY,
  );
  const issueByTraceId = useMemo(() => {
    const map = new Map<string, IssueFixture>();
    for (const issue of issuesQuery.data ?? []) {
      for (const traceId of issue.occurrenceTraceIds) {
        const existing = map.get(traceId);
        if (
          !existing ||
          (existing.status === "resolved" && issue.status !== "resolved")
        ) {
          map.set(traceId, issue);
        }
      }
    }
    return map;
  }, [issuesQuery.data]);
  const resolveIssueForTrace = useCallback(
    (traceId: string): IssueFixture | undefined =>
      issueByTraceId.get(traceId) ?? issueForTrace(traceId),
    [issueByTraceId],
  );

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
      // Always revalidate the selected transcript on mount — soft-nav
      // with refetchOnMount:false kept a prior empty success cached
      // across deploys that fixed the empty-steps bug.
      refetchOnMount: "always",
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
    // Don't stomp a click still in flight — same guard as the
    // reconcile effects below. Intermediate `?id=` values from a
    // lagged patchQuery must not overwrite the freshest selection.
    if (
      justSelectedTraceIdRef.current === null ||
      paramId === justSelectedTraceIdRef.current
    ) {
      const nextId = traces.find((t) => t.id === paramId)?.id;
      if (nextId) setSelectedId(nextId);
    }
    if (
      justSelectedSessionIdRef.current === null ||
      paramSession === justSelectedSessionIdRef.current
    ) {
      const nextSession = sessions.find((s) => s.id === paramSession)?.id;
      if (nextSession) setSelectedSessionId(nextSession);
    }
    if (paramSpan) setFocusStepId(paramSpan);
  }, [paramId, paramSpan, paramView, paramSession, traces, sessions]);

  // Keep tab state in sync with the URL even when `?tab=` is cleared
  // (Transcript) — otherwise Tree stays selected after navigating
  // back to a run whose URL has no tab param.
  useEffect(() => {
    setTab(parseTab(paramTab));
  }, [paramTab]);

  useEffect(() => {
    setSignalsDismissed(false);
    setOpenIds(new Set());
    if (!paramSpan) {
      setFocusStepId(null);
    }
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
          resolveSessionForTrace(
            traces.find((t) => t.id === selectedId) ?? { id: selectedId },
            sessions,
          )?.id ||
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
    [patchQuery, selectedId, selectedSessionId, sessions, traces],
  );

  const selectTrace = useCallback(
    (id: string, nextTab?: DetailTab) => {
      justSelectedTraceIdRef.current = id;
      setSelectedId(id);
      const resolvedTab = nextTab ?? tab;
      setTab(resolvedTab);
      const sess = resolveSessionForTrace(
        traces.find((t) => t.id === id) ?? { id },
        sessions,
      );
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
    [patchQuery, tab, hubView, sessions, traces],
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
    traces.find((t) => t.id === selectedId);

  // Merge in the real transcript once the detail fetch for this
  // trace resolves; falls back to the list row's `steps: []` while
  // loading (or if the detail fetch fails) so the rest of the page
  // never has to special-case a missing trace. Also prefer detail
  // cost/signals — list rows may still show $0 until estimate lands.
  //
  // Merge on `selectedId` (not `selectedListItem.id`) so an agent /
  // severity filter that temporarily drops the row from `filtered`
  // cannot leave detail steps stranded while the header still names
  // the URL-selected run.
  const selected = useMemo(() => {
    const detail = traceDetailQuery.data;
    if (detail && detail.id === selectedId) {
      const base = selectedListItem ?? detail;
      return {
        ...base,
        ...detail,
        steps: Array.isArray(detail.steps) ? detail.steps : [],
        costUsd: detail.costUsd ?? base.costUsd,
        tokens: detail.tokens || base.tokens,
        signals: detail.signals?.title ? detail.signals : base.signals,
      };
    }
    return selectedListItem;
  }, [selectedListItem, traceDetailQuery.data, selectedId]);

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
    if (!selectedId) return;
    if (!filtered.some((t) => t.id === selectedId) && filtered[0]) {
      selectTrace(filtered[0].id, "trace");
    }
  }, [hubView, filtered, selectedId, selectTrace]);

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
            if (
              t === "trace" ||
              t === "tree" ||
              t === "signals" ||
              t === "chat"
            ) {
              setDetailTab(t);
            }
          }
        : undefined,
  });

  // ---- Virtualised feed -------------------------------------------
  // One flat row model for all three list shapes (sessions, agent-
  // grouped runs, flat runs) so a single virtualiser covers them.
  const feedRows = useMemo<FeedRow[]>(() => {
    if (hubView === "sessions") {
      return filteredSessions.map((s, i) => ({
        kind: "session" as const,
        key: s.id,
        session: s,
        pos: i + 1,
      }));
    }
    if (agentId === "all" && groups.length > 0) {
      const out: FeedRow[] = [];
      let pos = 0;
      for (const group of groups) {
        out.push({
          kind: "group" as const,
          key: `group:${group.agent.id}`,
          agent: group.agent,
          count: group.items.length,
        });
        for (const t of group.items) {
          pos += 1;
          out.push({
            kind: "run" as const,
            key: t.id,
            trace: t,
            showAgent: false,
            pos,
          });
        }
      }
      return out;
    }
    return filtered.map((t, i) => ({
      kind: "run" as const,
      key: t.id,
      trace: t,
      showAgent: agentId === "all",
      pos: i + 1,
    }));
  }, [hubView, filteredSessions, agentId, groups, filtered]);

  const feedSetSize = hubView === "sessions" ? filteredSessions.length : filtered.length;

  // Agent group headers keep their sticky behaviour: the range
  // extractor pins whichever header precedes the visible window so it
  // is always mounted, and that one row renders `position: sticky`
  // instead of absolute (every other row is out of flow, so the sticky
  // one is free to travel the whole scrollport).
  const stickyIndexes = useMemo(() => {
    const out: number[] = [];
    feedRows.forEach((row, i) => {
      if (row.kind === "group") out.push(i);
    });
    return out;
  }, [feedRows]);
  const activeStickyIndexRef = useRef(-1);

  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const feedRangeExtractor = useCallback(
    (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
      let sticky = -1;
      for (const i of stickyIndexes) {
        if (i <= range.startIndex) sticky = i;
        else break;
      }
      activeStickyIndexRef.current = sticky;
      const next = new Set(defaultRangeExtractor(range));
      if (sticky >= 0) next.add(sticky);
      return [...next].sort((a, b) => a - b);
    },
    [stickyIndexes],
  );

  const feedVirtualizer = useVirtualizer({
    count: feedRows.length,
    getScrollElement: () => feedScrollRef.current,
    estimateSize: (index) =>
      feedRows[index]?.kind === "group"
        ? FEED_GROUP_ESTIMATE
        : FEED_ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index) => feedRows[index]?.key ?? index,
    rangeExtractor: feedRangeExtractor,
    measureElement: measureVirtualRow,
  });

  const selectedFeedIndex = useMemo(() => {
    if (hubView === "sessions" && !inspectingTurn && selectedSession) {
      return feedRows.findIndex(
        (r) => r.kind === "session" && r.session.id === selectedSession.id,
      );
    }
    if (!selected) return -1;
    return feedRows.findIndex(
      (r) => r.kind === "run" && r.trace.id === selected.id,
    );
  }, [feedRows, hubView, inspectingTurn, selected, selectedSession]);

  const feedVirtualizerRef = useRef(feedVirtualizer);
  feedVirtualizerRef.current = feedVirtualizer;

  // Replaces the old `document.querySelector(...).scrollIntoView()` —
  // with virtualisation the selected row is frequently not mounted, so
  // keyboard j/k navigation has to drive the virtualiser by index.
  useEffect(() => {
    if (selectedFeedIndex < 0) return;
    feedVirtualizerRef.current.scrollToIndex(selectedFeedIndex, {
      align: "auto",
    });
  }, [selectedFeedIndex]);

  const agent = selected ? agentForTrace(selected) : undefined;
  const issue = selected ? resolveIssueForTrace(selected.id) : undefined;
  const session = selected
    ? resolveSessionForTrace(selected, sessions)
    : undefined;
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
          <div
            ref={feedScrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
            {...{ [VIRTUAL_SCROLL_ATTR]: "feed" }}
          >
            {feedRows.length === 0 ? (
              <EmptyState
                title={
                  hubView === "sessions"
                    ? query
                      ? `No matches for “${query}”`
                      : scopeAgent
                        ? `No sessions for ${scopeAgent.name}`
                        : "No matching sessions"
                    : query
                      ? `No matches for “${query}”`
                      : scopeAgent
                        ? `No runs for ${scopeAgent.name}`
                        : "No matching runs"
                }
              />
            ) : (
              <ul
                role="list"
                aria-label={hubView === "sessions" ? "Sessions" : "Runs"}
                className="relative"
                style={{ height: `${feedVirtualizer.getTotalSize()}px` }}
              >
                {feedVirtualizer.getVirtualItems().map((item) => {
                  const row = feedRows[item.index];
                  if (!row) return null;
                  const isStuck =
                    row.kind === "group" &&
                    activeStickyIndexRef.current === item.index;
                  return (
                    <li
                      key={item.key}
                      ref={feedVirtualizer.measureElement}
                      data-index={item.index}
                      role={row.kind === "group" ? "presentation" : undefined}
                      aria-posinset={row.kind === "group" ? undefined : row.pos}
                      aria-setsize={
                        row.kind === "group" ? undefined : feedSetSize
                      }
                      className={cn(
                        "w-full min-w-0",
                        isStuck
                          ? "sticky top-0 z-[2]"
                          : "absolute top-0 left-0",
                      )}
                      style={
                        isStuck
                          ? undefined
                          : { transform: `translateY(${item.start}px)` }
                      }
                    >
                      {row.kind === "group" ? (
                        <AgentGroupHeader
                          agent={row.agent}
                          count={row.count}
                          href={`/agents?id=${row.agent.id}`}
                        />
                      ) : row.kind === "session" ? (
                        <SessionListButton
                          session={row.session}
                          active={row.session.id === selectedSession?.id}
                          onSelect={selectSession}
                        />
                      ) : (
                        <RunListButton
                          trace={row.trace}
                          active={row.trace.id === selected?.id}
                          showAgent={row.showAgent}
                          onSelect={selectTrace}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
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
                          const sess = resolveSessionForTrace(selected, sessions);
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
                  <Fragment key={id}>
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
                  </Fragment>
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
                    {/* The detail fetch answers 503 when trace storage is
                        unreachable. Nothing read traceDetailQuery.isError,
                        so the list row's `steps: []` fell through and the
                        pane rendered "0 spans" over a blank transcript —
                        a customer during a database blip saw an empty
                        trace, not an error, with no way to retry. */}
                    {traceDetailQuery.isError ? (
                      <div className="p-6">
                        <QueryErrorPanel
                          error={traceDetailQuery.error}
                          onRetry={() => void traceDetailQuery.refetch()}
                        />
                      </div>
                    ) : traceDetailQuery.isLoading &&
                      selected.steps.length === 0 ? (
                      <EmptyState
                        title="Loading transcript"
                        body="Fetching spans for this run…"
                        compact
                      />
                    ) : !traceDetailQuery.isLoading &&
                      !traceDetailQuery.isFetching &&
                      selected.steps.length === 0 ? (
                      <EmptyState
                        title="No spans"
                        body="This run has no span events yet, or the transcript could not be reconstructed."
                        compact
                        action={
                          <button
                            type="button"
                            className="ds-btn ds-btn-ghost ds-btn-sm"
                            onClick={() => void traceDetailQuery.refetch()}
                          >
                            Retry
                          </button>
                        }
                      />
                    ) : (
                      <RunTranscript
                        key={selected.id}
                        steps={selected.steps}
                        defaultOpenIds={badStepIds}
                        focusStepId={focusStepId}
                        hideToolbar
                        openIds={openIds}
                        onOpenIdsChange={setOpenIds}
                      />
                    )}
                  </div>
                ) : null}
                {tab === "tree" ? (
                  <div className="min-h-0 h-full overflow-hidden">
                    {traceDetailQuery.isError ? (
                      <div className="p-6">
                        <QueryErrorPanel
                          error={traceDetailQuery.error}
                          onRetry={() => void traceDetailQuery.refetch()}
                        />
                      </div>
                    ) : traceDetailQuery.isLoading &&
                      selected.steps.length === 0 ? (
                      <EmptyState
                        title="Loading tree"
                        body="Fetching spans for this run…"
                        compact
                      />
                    ) : !traceDetailQuery.isLoading &&
                      !traceDetailQuery.isFetching &&
                      selected.steps.length === 0 ? (
                      <EmptyState
                        title="No spans"
                        body="This run has no span events yet, or the transcript could not be reconstructed."
                        compact
                        action={
                          <button
                            type="button"
                            className="ds-btn ds-btn-ghost ds-btn-sm"
                            onClick={() => void traceDetailQuery.refetch()}
                          >
                            Retry
                          </button>
                        }
                      />
                    ) : (
                      <TreePanel
                        steps={selected.steps}
                        focusStepId={focusStepId}
                        onFocus={focusStepInPlace}
                      />
                    )}
                  </div>
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
                  <ChatPanel key={selected.id} trace={selected} issue={issue} />
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
