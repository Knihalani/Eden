"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import {
  formatCheckpointTime,
  formatDuration,
  formatTokens,
  formatUsd,
  sessionCheckpoints,
  snapshotAtIndex,
  type DebuggerCheckpoint,
  type DebuggerSessionFixture,
} from "@/lab/fixtures/debugger";
import {
  TRACE_LIST,
  traceById,
  type TraceFixture,
} from "@/lab/fixtures/traces";
import { catalogTraces } from "@/lib/portal-catalog";
import { DebuggerOutcomeChip } from "@/lab/debugger/debugger-chrome";
import { EmptyState, RunTranscript, SeverityBadge } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { timeTravelApi } from "@/lib/api/resources";
import type { TimeTravelForkListItem } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import {
  buildForkTree,
  forkRowId,
  type ForkTreeNode,
} from "@/lab/debugger/fork-tree";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";

function liveCompareTraces(): TraceFixture[] {
  const live = catalogTraces();
  return live.length > 0 ? live : TRACE_LIST;
}

/* ------------------------------------------------------------------ */
/* Replay — re-run FROM a step                                         */
/* ------------------------------------------------------------------ */

export function DebuggerReplayView({
  session,
  focusSpanId,
  onFocusSpan,
  onReplay,
  sourceTrace,
  liveTravelNote,
  sourceTraceLoading,
  sourceTraceError,
  onRetrySourceTrace,
}: {
  session: DebuggerSessionFixture;
  focusSpanId?: string | null;
  onFocusSpan: (spanId: string | null) => void;
  onReplay: (
    checkpoint: DebuggerCheckpoint,
    fromStep: number,
  ) => void | Promise<void>;
  /** Hydrated detail from ``portalApi.traceDetail`` (list rows have empty steps). */
  sourceTrace?: TraceFixture | null;
  /** Honest copy when live Cat 20 re-exec is off. */
  liveTravelNote?: string | null;
  sourceTraceLoading?: boolean;
  sourceTraceError?: Error | null;
  onRetrySourceTrace?: () => void;
}) {
  const checkpoints = sessionCheckpoints(session, sourceTrace);
  const trace = sourceTrace ?? traceById(session.sourceTraceId);
  const [selectedId, setSelectedId] = useState(
    () =>
      checkpoints.find((c) => c.spanId === focusSpanId)?.id ??
      checkpoints.find((c) => c.status === "error")?.id ??
      checkpoints[0]?.id ??
      null,
  );
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!focusSpanId) return;
    const match = checkpoints.find((c) => c.spanId === focusSpanId);
    if (match) setSelectedId(match.id);
  }, [focusSpanId, checkpoints]);

  const selectedIndex = checkpoints.findIndex((c) => c.id === selectedId);
  const selected = selectedIndex >= 0 ? checkpoints[selectedIndex]! : null;

  if (sourceTraceLoading && !trace) {
    return <QueryLoadingPanel label="Loading source trace…" />;
  }

  if (sourceTraceError && !trace) {
    return (
      <QueryErrorPanel
        error={sourceTraceError}
        onRetry={onRetrySourceTrace}
      />
    );
  }

  if (!trace) {
    return (
      <EmptyState
        title="No source trace"
        body={U20_EMPTY_COPY.debugger}
        action={
          <Link href="/traces" className="ds-btn ds-btn-primary ds-btn-sm">
            Open traces
          </Link>
        }
        compact
      />
    );
  }

  const fromHereSteps =
    selectedIndex >= 0 ? trace.steps.slice(selectedIndex) : trace.steps;

  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[16.5rem_1fr]">
      <aside className="flex min-h-0 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
        <div className="border-b border-[var(--line)] px-3 py-2.5">
          <p className="type-label">Re-run from</p>
          <p className="type-meta mt-0.5">{checkpoints.length} steps</p>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {checkpoints.map((cp) => {
            const active = selectedId === cp.id;
            return (
              <li key={cp.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(cp.id);
                    onFocusSpan(cp.spanId ?? null);
                  }}
                  className={cn(
                    "w-full border-b border-[var(--line)] px-3 py-2.5 text-left transition-colors",
                    active
                      ? "bg-[var(--bg-active)] shadow-[inset_2px_0_0_var(--accent)]"
                      : "hover:bg-[var(--bg-hover)]",
                  )}
                >
                  <p className="type-meta flex items-center justify-between gap-2">
                    <span className="text-[var(--text-faint)]">
                      {formatCheckpointTime(cp.atMs)}
                    </span>
                    <DebuggerOutcomeChip outcome={cp.status} />
                  </p>
                  <p className="type-ui mt-0.5 line-clamp-2 text-[var(--text)]">
                    {cp.label}
                  </p>
                  {active ? (
                    <p className="type-meta mt-1 flex items-center gap-1 text-[var(--accent)]">
                      <Play className="h-3 w-3 fill-current" aria-hidden />
                      Start here
                    </p>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="flex min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
          <p className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
            {selected ? selected.label : "Pick a step"}
          </p>
          {selected ? (
            <DebuggerOutcomeChip outcome={selected.status} />
          ) : null}
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={!selected || running}
            onClick={() => {
              if (!selected) return;
              setRunning(true);
              void Promise.resolve(
                onReplay(selected, Math.max(0, selectedIndex)),
              ).finally(() => setRunning(false));
            }}
          >
            <Play className="h-3.5 w-3.5 fill-current" aria-hidden />
            {running ? "Re-running…" : "Hermetic re-run"}
          </button>
        </div>

        {liveTravelNote ? (
          <div className="shrink-0 border-b border-[var(--line)] px-4 py-2 sm:px-5">
            <p className="type-meta text-[var(--text-faint)]">{liveTravelNote}</p>
          </div>
        ) : null}

        {session.lastReplay ? (
          <div className="shrink-0 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
            <p className="type-label flex flex-wrap items-center gap-2">
              Last result · {session.lastReplay.at}
              <DebuggerOutcomeChip outcome={session.lastReplay.outcome} />
            </p>
            <p className="type-meta mt-1 text-[var(--text-secondary)]">
              {session.lastReplay.summary}
            </p>
          </div>
        ) : null}

        {selectedIndex > 0 ? (
          <div className="shrink-0 border-b border-[var(--line)] px-4 py-2 sm:px-5">
            <p className="type-meta text-[var(--text-faint)]">
              ↓ From here · {selectedIndex} earlier step
              {selectedIndex === 1 ? "" : "s"} skipped
            </p>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden">
          <RunTranscript
            steps={fromHereSteps}
            traceId={trace.id}
            syncStepToUrl={false}
            focusStepId={fromHereSteps[0]?.id ?? null}
            defaultOpenIds={
              fromHereSteps[0]
                ? [
                    fromHereSteps[0].id,
                    ...fromHereSteps
                      .filter((s) => s.status === "error")
                      .map((s) => s.id),
                  ]
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Compare — baseline vs candidate                                     */
/* ------------------------------------------------------------------ */

export function DebuggerCompareView({
  session,
  leftTraceId,
  rightTraceId,
  onLeftChange,
  onRightChange,
  leftTrace,
  rightTrace,
  detailsLoading,
}: {
  session: DebuggerSessionFixture;
  leftTraceId: string;
  rightTraceId: string;
  onLeftChange: (id: string) => void;
  onRightChange: (id: string) => void;
  leftTrace?: TraceFixture | null;
  rightTrace?: TraceFixture | null;
  detailsLoading?: boolean;
}) {
  const left = leftTrace ?? traceById(leftTraceId);
  const right = rightTrace ?? traceById(rightTraceId);
  const options = useMemo(() => {
    const pool = liveCompareTraces();
    const scoped = pool.filter((t) => t.agentId === session.agentId);
    const base = scoped.length >= 2 ? scoped : pool;
    const ids = new Set(base.map((t) => t.id));
    const extras = pool.filter(
      (t) =>
        (t.id === leftTraceId || t.id === rightTraceId) && !ids.has(t.id),
    );
    return [...extras, ...base];
  }, [session.agentId, leftTraceId, rightTraceId]);

  const delta = left && right ? compareDelta(left, right) : null;
  const focusLeft = delta?.firstDiffStepIdLeft ?? null;
  const focusRight = delta?.firstDiffStepIdRight ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2.5 border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[10rem] flex-1 space-y-1">
            <span className="type-label">Baseline</span>
            <select
              className="ds-input w-full"
              value={leftTraceId}
              onChange={(e) => onLeftChange(e.target.value)}
            >
              {options.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-[10rem] flex-1 space-y-1">
            <span className="type-label">Candidate</span>
            <select
              className="ds-input w-full"
              value={rightTraceId}
              onChange={(e) => onRightChange(e.target.value)}
            >
              {options.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {delta ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <DeltaStat label="Duration" value={delta.duration} />
            <DeltaStat label="Cost" value={delta.cost} />
            <DeltaStat label="Spans" value={delta.spans} />
            <DeltaStat label="Status" value={delta.status} />
            {delta.firstDiff ? (
              <p className="type-meta text-[var(--accent)]">
                Fork · {delta.firstDiff}
              </p>
            ) : null}
            <Link
              href={`/compare?from=debugger&debuggerSession=${session.id}&agent=${session.agentId}`}
              className="type-meta text-[var(--accent)] underline-offset-2 hover:underline"
            >
              Open A/B compare
            </Link>
          </div>
        ) : null}
      </div>

      {detailsLoading && (!left || !right) ? (
        <QueryLoadingPanel label="Loading compare traces…" />
      ) : !left || !right ? (
        <EmptyState
          title="Pick two traces"
          body="Choose a baseline and a candidate."
          compact
        />
      ) : (
        <div className="grid min-h-0 flex-1 md:grid-cols-2">
          <ComparePane
            label="Baseline"
            trace={left}
            focusStepId={focusLeft}
          />
          <ComparePane
            label="Candidate"
            trace={right}
            focusStepId={focusRight}
            edge
          />
        </div>
      )}
    </div>
  );
}

function DeltaStat({ label, value }: { label: string; value: string }) {
  return (
    <p className="type-meta">
      <span className="text-[var(--text-faint)]">{label}</span>{" "}
      <span className="text-[var(--text)]">{value}</span>
    </p>
  );
}

function compareDelta(left: TraceFixture, right: TraceFixture) {
  const dMs = right.durationMs - left.durationMs;
  const bothCostsKnown = left.costUsd != null && right.costUsd != null;
  const dCost = bothCostsKnown
    ? (right.costUsd as number) - (left.costUsd as number)
    : null;
  const dSpans = right.steps.length - left.steps.length;
  const max = Math.max(left.steps.length, right.steps.length);
  let firstDiff: string | null = null;
  let firstDiffStepIdLeft: string | null = null;
  let firstDiffStepIdRight: string | null = null;
  for (let i = 0; i < max; i++) {
    const a = left.steps[i];
    const b = right.steps[i];
    if (!a || !b || a.title !== b.title || a.status !== b.status) {
      firstDiff = b?.title ?? a?.title ?? `step ${i + 1}`;
      firstDiffStepIdLeft = a?.id ?? null;
      firstDiffStepIdRight = b?.id ?? null;
      break;
    }
  }
  return {
    duration: `${dMs >= 0 ? "+" : ""}${formatDuration(Math.abs(dMs))}${dMs >= 0 ? " slower" : " faster"}`,
    cost:
      dCost == null
        ? "—"
        : `${dCost >= 0 ? "+" : "−"}${formatUsd(Math.abs(dCost))}`,
    spans: `${dSpans >= 0 ? "+" : ""}${dSpans}`,
    status: `${left.status} → ${right.status}`,
    firstDiff,
    firstDiffStepIdLeft,
    firstDiffStepIdRight,
  };
}

function ComparePane({
  label,
  trace,
  focusStepId,
  edge,
}: {
  label: string;
  trace: TraceFixture;
  focusStepId?: string | null;
  edge?: boolean;
}) {
  const openIds = [
    ...(focusStepId ? [focusStepId] : []),
    ...trace.steps.filter((s) => s.status === "error").map((s) => s.id),
  ];
  return (
    <section
      className={cn(
        "flex min-h-0 flex-col border-b border-[var(--line)] md:border-b-0",
        edge && "md:border-l",
      )}
    >
      <header className="shrink-0 space-y-1 border-b border-[var(--line)] px-4 py-3">
        <p className="type-label">{label}</p>
        <p className="type-ui text-[var(--text)]">{trace.name}</p>
        <p className="type-meta flex flex-wrap items-center gap-2">
          <SeverityBadge severity={trace.severity} />
          <span>{formatDuration(trace.durationMs)}</span>
          <span>{formatUsd(trace.costUsd)}</span>
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <RunTranscript
          steps={trace.steps}
          compact
          traceId={trace.id}
          syncStepToUrl={false}
          focusStepId={focusStepId}
          defaultOpenIds={openIds}
        />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Inspect — freeze AT a step (no re-run)                              */
/* ------------------------------------------------------------------ */

export function DebuggerInspectView({
  session,
  focusSpanId,
  onFocusSpan,
  sourceTrace,
  sourceTraceLoading,
  sourceTraceError,
  onRetrySourceTrace,
}: {
  session: DebuggerSessionFixture;
  focusSpanId?: string | null;
  onFocusSpan: (spanId: string | null) => void;
  sourceTrace?: TraceFixture | null;
  sourceTraceLoading?: boolean;
  sourceTraceError?: Error | null;
  onRetrySourceTrace?: () => void;
}) {
  const checkpoints = sessionCheckpoints(session, sourceTrace);
  const trace = sourceTrace ?? traceById(session.sourceTraceId);

  const initialIndex = useMemo(() => {
    if (!checkpoints.length) return 0;
    const bySpan = checkpoints.findIndex((c) => c.spanId === focusSpanId);
    if (bySpan >= 0) return bySpan;
    const byFail = checkpoints.findIndex((c) => c.status === "error");
    return byFail >= 0 ? byFail : 0;
  }, [checkpoints, focusSpanId]);

  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    setIndex(initialIndex);
  }, [session.id, initialIndex]);

  const snap =
    trace && checkpoints.length
      ? snapshotAtIndex(trace, checkpoints, index)
      : null;

  function go(nextIndex: number) {
    if (!checkpoints.length) return;
    const clamped = Math.min(Math.max(nextIndex, 0), checkpoints.length - 1);
    setIndex(clamped);
    onFocusSpan(checkpoints[clamped]?.spanId ?? null);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        go(index + 1);
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        go(index - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, checkpoints]);

  if (
    sourceTraceLoading &&
    (!trace || checkpoints.length === 0)
  ) {
    return <QueryLoadingPanel label="Loading source trace…" />;
  }

  if (sourceTraceError && (!trace || checkpoints.length === 0)) {
    return (
      <QueryErrorPanel
        error={sourceTraceError}
        onRetry={onRetrySourceTrace}
      />
    );
  }

  if (!trace || checkpoints.length === 0 || !snap) {
    return (
      <EmptyState
        title="No steps"
        body={U20_EMPTY_COPY.debugger}
        compact
      />
    );
  }

  const attrEntries = Object.entries(snap.attributes).slice(0, 6);

  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[16.5rem_1fr]">
      <aside className="flex min-h-0 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
        <div className="border-b border-[var(--line)] px-3 py-2.5">
          <p className="type-label">Freeze at</p>
          <p className="type-meta mt-0.5">
            Step {index + 1} of {checkpoints.length}
          </p>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Steps">
          {checkpoints.map((cp, i) => (
            <li key={cp.id}>
              <button
                type="button"
                onClick={() => go(i)}
                aria-current={i === index ? "step" : undefined}
                className={cn(
                  "w-full border-b border-[var(--line)] px-3 py-2.5 text-left transition-colors",
                  i === index
                    ? "bg-[var(--bg-active)] shadow-[inset_2px_0_0_var(--accent)]"
                    : "hover:bg-[var(--bg-hover)]",
                  i > index && "opacity-45",
                )}
              >
                <p className="type-meta flex items-center justify-between gap-2">
                  <span className="text-[var(--text-faint)]">
                    {i + 1} · {formatCheckpointTime(cp.atMs)}
                  </span>
                  <DebuggerOutcomeChip outcome={cp.status} />
                </p>
                <p className="type-ui mt-0.5 line-clamp-2 text-[var(--text)]">
                  {cp.label}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex min-h-0 flex-col overflow-y-auto">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon"
            aria-label="Previous step"
            disabled={index <= 0}
            onClick={() => go(index - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <p className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
            {snap.checkpoint.label}
          </p>
          <span className="type-meta text-[var(--text-faint)]">
            {index + 1}/{checkpoints.length}
          </span>
          <DebuggerOutcomeChip outcome={snap.checkpoint.status} />
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon"
            aria-label="Next step"
            disabled={index >= checkpoints.length - 1}
            onClick={() => go(index + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="grid shrink-0 gap-px border-b border-[var(--line)] bg-[var(--line)] md:grid-cols-2">
          <div className="bg-[var(--bg)] px-4 py-3 sm:px-5">
            <p className="type-label text-[var(--text-faint)]">Input</p>
            <pre className="type-mono mt-2 max-h-32 overflow-auto whitespace-pre-wrap !text-[0.75rem] !text-[var(--text)]">
              {snap.entering}
            </pre>
          </div>
          <div className="bg-[var(--bg)] px-4 py-3 sm:px-5">
            <p className="type-label text-[var(--text-faint)]">Output</p>
            <pre
              className={cn(
                "type-mono mt-2 max-h-32 overflow-auto whitespace-pre-wrap !text-[0.75rem]",
                snap.checkpoint.status === "error"
                  ? "!text-[var(--error)]"
                  : "!text-[var(--text)]",
              )}
            >
              {snap.leaving}
            </pre>
          </div>
        </div>

        <div className="shrink-0 border-b border-[var(--line)] px-4 py-3 sm:px-5">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat term="Elapsed" def={formatDuration(snap.elapsedMs)} />
            <Stat term="Tokens" def={formatTokens(snap.tokens)} />
            <Stat term="Cost" def={formatUsd(snap.costUsd)} />
            <Stat
              term="Failures"
              def={String(snap.errorCount)}
              warn={snap.errorCount > 0}
            />
          </dl>
          {(snap.model || attrEntries.length > 0) && (
            <p className="type-meta mt-2.5 text-[var(--text-secondary)]">
              {snap.model
                ? `${snap.provider ?? "model"} · ${snap.model}`
                : null}
              {snap.model && attrEntries.length ? " · " : null}
              {attrEntries.length
                ? attrEntries
                    .slice(0, 3)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(" · ")
                : null}
            </p>
          )}
        </div>

        <div className="min-h-[12rem] flex-1 overflow-hidden">
          <RunTranscript
            steps={trace.steps.slice(0, index + 1)}
            traceId={trace.id}
            syncStepToUrl={false}
            focusStepId={snap.step.id}
            defaultOpenIds={[snap.step.id]}
          />
        </div>
      </div>
    </div>
  );
}

function ForkTreeRow({ fork }: { fork: TimeTravelForkListItem }) {
  return (
    <>
      <span className="text-[var(--text)]">{forkRowId(fork)}</span>
      {" · step "}
      {String(fork.fork_at_step ?? "?")}
      {fork.name ? ` · ${String(fork.name)}` : ""}
      {fork.last_replay_outcome
        ? ` · last=${String(fork.last_replay_outcome)}`
        : ""}
    </>
  );
}

function ForkTreeList({
  nodes,
  depth = 0,
}: {
  nodes: ForkTreeNode[];
  depth?: number;
}) {
  if (nodes.length === 0) return null;
  return (
    <ul className={cn("mt-2 space-y-2", depth > 0 && "ml-4 border-l border-[var(--line)] pl-3")}>
      {nodes.map((node) => (
        <li key={forkRowId(node.fork)}>
          <div className="type-meta rounded-[var(--radius)] border border-[var(--line)] px-3 py-2">
            <ForkTreeRow fork={node.fork} />
          </div>
          {node.children.length > 0 ? (
            <ForkTreeList nodes={node.children} depth={depth + 1} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Time travel — Cat 20 fork / live replay / side-by-side timeline     */
/* ------------------------------------------------------------------ */

type ReplayStepStatus = "cache" | "live" | "miss" | "pending";

function replayStatusForStep(
  stepIndex: number,
  replay: TimeTravelReplayData | null,
): ReplayStepStatus {
  if (!replay) return "pending";
  if (replay.served_from_cache?.includes(stepIndex)) return "cache";
  if (replay.cache_miss_warnings?.includes(stepIndex)) return "miss";
  if (replay.re_executed?.includes(stepIndex)) return "live";
  return "pending";
}

function ReplayStatusChip({ status }: { status: ReplayStepStatus }) {
  const label =
    status === "cache"
      ? "cache"
      : status === "live"
        ? "live"
        : status === "miss"
          ? "miss"
          : "—";
  const tone =
    status === "cache"
      ? "text-[var(--success)]"
      : status === "live"
        ? "text-[var(--accent)]"
        : status === "miss"
          ? "text-[var(--warning)]"
          : "text-[var(--text-faint)]";
  return <span className={cn("type-meta uppercase tracking-wide", tone)}>{label}</span>;
}

export function DebuggerTimeTravelView({
  session,
  orgId,
  sourceTrace,
  focusSpanId,
  onFocusSpan,
}: {
  session: DebuggerSessionFixture;
  orgId: string | null;
  sourceTrace?: TraceFixture | null;
  focusSpanId?: string | null;
  onFocusSpan?: (spanId: string | null) => void;
}) {
  const fallbackCheckpoints = sessionCheckpoints(session, sourceTrace);
  const sourceTraceId = session.sourceTraceId || null;

  const stepsQuery = useOrgQuery(
    queryKeys.timeTravel.steps(orgId, sourceTraceId),
    orgId,
    async () => {
      const res = await timeTravelApi.listSteps(orgId!, sourceTraceId!);
      return res?.data ?? null;
    },
    {
      ...SHELL_QUERY,
      staleTime: 15_000,
      enabled: Boolean(orgId && sourceTraceId),
    },
  );
  const forksQuery = useOrgQuery(
    queryKeys.timeTravel.forks(orgId, sourceTraceId),
    orgId,
    async () => {
      const res = await timeTravelApi.listForks(orgId!, sourceTraceId!);
      const data = res?.data;
      return Array.isArray(data?.forks) ? data.forks : [];
    },
    {
      ...SHELL_QUERY,
      staleTime: 30_000,
      enabled: Boolean(orgId && sourceTraceId),
    },
  );

  const recordedSteps = stepsQuery.data?.steps ?? [];
  const usingRecorded = recordedSteps.length > 0;

  const timeline = useMemo(() => {
    if (usingRecorded) {
      return recordedSteps.map((s) => ({
        key: `rec_${s.step_index}`,
        stepIndex: s.step_index,
        label:
          s.prompt_preview?.slice(0, 80) ||
          (s.model ? `${s.model}` : `Step ${s.step_index}`),
        spanId: s.span_id ?? null,
        cacheable: s.cacheable,
        replayable: s.replayable,
        model: s.model ?? null,
        tokens: s.tokens_used ?? 0,
        costUsd: s.cost_usd ?? null,
        promptPreview: s.prompt_preview ?? null,
        responseHash: s.response_hash ?? "",
      }));
    }
    return fallbackCheckpoints.map((cp, i) => ({
      key: cp.id,
      stepIndex: i,
      label: cp.label,
      spanId: cp.spanId ?? null,
      cacheable: false,
      replayable: false,
      model: null as string | null,
      tokens: 0,
      costUsd: null as number | null,
      promptPreview: cp.summary || null,
      responseHash: "",
    }));
  }, [usingRecorded, recordedSteps, fallbackCheckpoints]);

  const initialIndex = useMemo(() => {
    if (!timeline.length) return 0;
    if (focusSpanId) {
      const bySpan = timeline.findIndex((s) => s.spanId === focusSpanId);
      if (bySpan >= 0) return bySpan;
    }
    const firstFail = fallbackCheckpoints.findIndex((c) => c.status === "error");
    if (firstFail >= 0 && firstFail < timeline.length) return firstFail;
    return Math.max(0, timeline.length - 1);
  }, [timeline, focusSpanId, fallbackCheckpoints]);

  const [index, setIndex] = useState(initialIndex);
  /** Sticky fork point — scrubbing timeline must not move this or the
   * Edit vs Replay-result pane collapses to always-edit. */
  const [forkAtStep, setForkAtStep] = useState(
    () => timeline[initialIndex]?.stepIndex ?? 0,
  );
  const [promptEdit, setPromptEdit] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [forkId, setForkId] = useState<string | null>(null);
  const [replay, setReplay] = useState<TimeTravelReplayData | null>(null);
  const [diff, setDiff] = useState<TimeTravelDiffData | null>(null);
  const [playing, setPlaying] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    setIndex(initialIndex);
    setForkAtStep(timeline[initialIndex]?.stepIndex ?? 0);
    setReplay(null);
    setDiff(null);
    setForkId(null);
    setPromptEdit("");
     
  }, [session.id, initialIndex]);

  const current = timeline[index] ?? null;
  const forkAt = forkAtStep;
  const forkAtTimelineIndex = timeline.findIndex(
    (s) => s.stepIndex === forkAtStep,
  );
  const atForkStep =
    forkAtTimelineIndex >= 0 ? index === forkAtTimelineIndex : true;

  function go(nextIndex: number) {
    if (!timeline.length) return;
    const clamped = Math.min(Math.max(nextIndex, 0), timeline.length - 1);
    setIndex(clamped);
    onFocusSpan?.(timeline[clamped]?.spanId ?? null);
  }

  const onForkAndReplay = async () => {
    if (!orgId || !sourceTraceId) {
      setActionError("Missing org or source trace.");
      return;
    }
    if (!usingRecorded) {
      setActionError(
        "This trace has no recorded agent.step events yet. Route LLM calls through Eden’s AI gateway (with the same trace_id) so Time travel can fork the whole run.",
      );
      return;
    }
    const readyNow = Boolean(stepsQuery.data?.ready_for_live_replay);
    if (!readyNow) {
      setActionError(
        "None of the recorded steps include prompt content — live re-exec will return cannot_replay.",
      );
      return;
    }
    // Capture scrub position as the fork point before replay resets index.
    const forkStep = current?.stepIndex ?? forkAtStep;
    setForkAtStep(forkStep);
    if (busyRef.current) return;
    setBusy(true);
    setActionError(null);
    setReplay(null);
    setDiff(null);
    try {
      const edits: Record<string, unknown> = {};
      if (promptEdit.trim()) {
        edits[`step_${forkStep}.prompt`] = promptEdit.trim();
      }
      const forkRes = await timeTravelApi.fork(orgId, {
        parent_trace_id: sourceTraceId,
        fork_at_step: forkStep,
        name: `Fork @ step ${forkStep}`,
        edits,
      });
      const newForkId = String(forkRes?.data?.fork_id || "");
      if (!newForkId) {
        throw new Error("Fork response missing fork_id");
      }
      setForkId(newForkId);

      const replayRes = await timeTravelApi.replay(orgId, {
        fork_id: newForkId,
        edits,
      });
      const replayData = replayRes?.data ?? null;
      if (!replayData?.replay_id) {
        throw new Error(
          replayRes?.message || "Replay did not return a replay_id",
        );
      }
      setReplay(replayData);

      try {
        const diffRes = await timeTravelApi.diff(
          orgId,
          newForkId,
          replayData.replay_id,
        );
        setDiff(diffRes?.data ?? null);
      } catch (diffErr) {
        setActionError(
          diffErr instanceof Error
            ? `Replay succeeded; diff unavailable: ${diffErr.message}`
            : "Replay succeeded; diff unavailable",
        );
      }
      await forksQuery.refetch();
      setPlaying(true);
      // Scrub from start so Replay-result rows are visible; forkAtStep stays.
      setIndex(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Time travel failed";
      setActionError(
        /503|disabled/i.test(msg)
          ? `${msg} — live replay may be disabled (TIME_TRAVEL_REPLAY_ENABLED).`
          : /no_usable_prompt|cannot_replay/i.test(msg)
            ? `${msg} — historical steps without recorded prompt cannot re-exec.`
            : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        go(index + 1);
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        go(index - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, timeline]);

  useEffect(() => {
    if (!playing || !timeline.length) return;
    const id = window.setInterval(() => {
      setIndex((prev) => {
        if (prev >= timeline.length - 1) {
          setPlaying(false);
          return prev;
        }
        const next = prev + 1;
        onFocusSpan?.(timeline[next]?.spanId ?? null);
        return next;
      });
    }, 900);
    return () => window.clearInterval(id);
  }, [playing, timeline, onFocusSpan]);

  const forks = forksQuery.data ?? [];
  const forkTree = useMemo(() => buildForkTree(forks), [forks]);
  const error =
    actionError ??
    (stepsQuery.isError
      ? stepsQuery.error instanceof Error
        ? stepsQuery.error.message
        : "Failed to load recorded steps"
      : forksQuery.isError
        ? forksQuery.error instanceof Error
          ? forksQuery.error.message
          : "Failed to list forks"
        : null);

  const diffEntries = useMemo(() => {
    if (!diff?.diff) return [];
    if (Array.isArray(diff.diff)) return [];
    return Object.entries(diff.diff).slice(0, 24);
  }, [diff]);

  if (!sourceTraceId) {
    return (
      <EmptyState
        title="No source trace"
        body="Seed a debugger session from a Trace to time-travel across its run."
        compact
      />
    );
  }

  if (stepsQuery.isLoading && !timeline.length) {
    return (
      <div className="flex flex-1 items-center justify-center px-5">
        <p className="type-meta">Loading recorded steps…</p>
      </div>
    );
  }

  if (!timeline.length) {
    return (
      <EmptyState
        title="No steps on this run"
        body="Open a trace with spans, or ensure the agent recorded LLM steps through Eden’s gateway."
        compact
      />
    );
  }

  const ready = Boolean(stepsQuery.data?.ready_for_live_replay);
  const nCacheable = stepsQuery.data?.n_cacheable ?? 0;
  const nReplayable = stepsQuery.data?.n_replayable ?? 0;

  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[16.5rem_1fr]">
      <aside className="flex min-h-0 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
        <div className="border-b border-[var(--line)] px-3 py-2.5">
          <p className="type-label">Fork from</p>
          <p className="type-meta mt-0.5">
            Step {forkAt} · {index + 1}/{timeline.length}
            {usingRecorded ? " · recorded" : " · span map"}
          </p>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Time travel steps">
          {timeline.map((step, i) => {
            const status = replayStatusForStep(step.stepIndex, replay);
            return (
              <li key={step.key}>
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={i === index ? "step" : undefined}
                  className={cn(
                    "w-full border-b border-[var(--line)] px-3 py-2.5 text-left transition-colors",
                    i === index
                      ? "bg-[var(--bg-active)] shadow-[inset_2px_0_0_var(--accent)]"
                      : "hover:bg-[var(--bg-hover)]",
                    i < index && replay ? "opacity-80" : i > index ? "opacity-55" : "",
                  )}
                >
                  <p className="type-meta flex items-center justify-between gap-2">
                    <span className="text-[var(--text-faint)]">
                      {step.stepIndex}
                      {step.cacheable ? " · cacheable" : ""}
                      {!step.replayable && usingRecorded ? " · no prompt" : ""}
                    </span>
                    {replay ? <ReplayStatusChip status={status} /> : null}
                  </p>
                  <p className="type-ui mt-0.5 line-clamp-2 text-[var(--text)]">
                    {step.label}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="flex min-h-0 flex-col overflow-y-auto">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon"
            aria-label="Previous step"
            disabled={index <= 0}
            onClick={() => go(index - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon"
            aria-label={playing ? "Pause playback" : "Play through run"}
            onClick={() => setPlaying((v) => !v)}
          >
            {playing ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </button>
          <p className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
            {current?.label}
          </p>
          <span className="type-meta text-[var(--text-faint)]">
            {index + 1}/{timeline.length}
          </span>
          {replay ? (
            <ReplayStatusChip
              status={replayStatusForStep(forkAt, replay)}
            />
          ) : null}
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon"
            aria-label="Next step"
            disabled={index >= timeline.length - 1}
            onClick={() => go(index + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {!usingRecorded ? (
          <div className="border-b border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3 sm:px-5">
            <p className="type-ui text-[var(--text)]">
              Showing portal span map — live fork needs recorded{" "}
              <code className="type-meta">agent.step</code> events.
            </p>
            <p className="type-meta mt-1 text-[var(--text-secondary)]">
              Route this agent through Eden’s AI gateway with a stable{" "}
              <code className="type-meta">trace_id</code> so every LLM call
              is captured for the whole run.
            </p>
          </div>
        ) : !ready ? (
          <div className="border-b border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3 sm:px-5">
            <p className="type-ui text-[var(--text)]">
              {recordedSteps.length} step(s) recorded, but none include prompt
              content — live re-exec will return{" "}
              <code className="type-meta">cannot_replay</code>.
            </p>
          </div>
        ) : null}

        <div className="grid shrink-0 gap-px border-b border-[var(--line)] bg-[var(--line)] md:grid-cols-2">
          <div className="bg-[var(--bg)] px-4 py-3 sm:px-5">
            <p className="type-label text-[var(--text-faint)]">Original</p>
            <pre className="type-mono mt-2 max-h-36 overflow-auto whitespace-pre-wrap !text-[0.75rem] !text-[var(--text)]">
              {current?.promptPreview?.trim() || "—"}
            </pre>
            <p className="type-meta mt-2 text-[var(--text-faint)]">
              {current?.model ? `${current.model} · ` : ""}
              hash {(current?.responseHash || "—").slice(0, 12)}
            </p>
          </div>
          <div className="bg-[var(--bg)] px-4 py-3 sm:px-5">
            <p className="type-label text-[var(--text-faint)]">
              {atForkStep ? "Edit + replay from here" : "Replay result"}
            </p>
            {atForkStep ? (
              <textarea
                className="ds-input mt-2 min-h-[5.5rem] w-full !text-[0.75rem]"
                placeholder="Optional prompt override for this step (step_N.prompt)"
                value={promptEdit}
                onChange={(e) => setPromptEdit(e.target.value)}
              />
            ) : (
              <pre className="type-mono mt-2 max-h-36 overflow-auto whitespace-pre-wrap !text-[0.75rem] !text-[var(--text)]">
                {(() => {
                  const r = diff?.replay?.find(
                    (s) => s.step_index === current?.stepIndex,
                  );
                  if (!r) {
                    return replay
                      ? "No replay row for this step."
                      : "Run a live replay to compare.";
                  }
                  const bits = [
                    r.served_from_cache ? "served from cache" : null,
                    r.re_executed ? "re-executed live" : null,
                    r.response_hash
                      ? `hash ${String(r.response_hash).slice(0, 12)}`
                      : null,
                    r.tokens_used != null ? `${r.tokens_used} tokens` : null,
                  ].filter(Boolean);
                  return bits.join(" · ") || "—";
                })()}
              </pre>
            )}
          </div>
        </div>

        <div className="shrink-0 border-b border-[var(--line)] px-4 py-3 sm:px-5">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat term="Recorded" def={String(timeline.length)} />
            <Stat term="Replayable" def={usingRecorded ? String(nReplayable) : "—"} />
            <Stat term="Cacheable" def={usingRecorded ? String(nCacheable) : "—"} />
            <Stat
              term="Saved"
              def={
                replay
                  ? `${formatTokens(replay.tokens_saved ?? 0)} · ${formatUsd(replay.cost_saved_usd ?? 0)}`
                  : "—"
              }
            />
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={busy || !orgId || !usingRecorded || !ready}
              onClick={() => void onForkAndReplay()}
              title={
                !usingRecorded
                  ? "Needs recorded agent.step events"
                  : !ready
                    ? "No replayable steps with prompt content"
                    : undefined
              }
            >
              {busy ? "Replaying…" : `Replay from step ${current?.stepIndex ?? forkAt}`}
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={busy || stepsQuery.isFetching}
              onClick={() => {
                void stepsQuery.refetch();
                void forksQuery.refetch();
              }}
            >
              Refresh
            </button>
            {forkId ? (
              <span className="type-meta self-center text-[var(--text-faint)]">
                fork {forkId}
                {replay?.replay_id ? ` · replay ${replay.replay_id}` : ""}
              </span>
            ) : null}
          </div>
          {replay ? (
            <p className="type-meta mt-2 text-[var(--text-secondary)]">
              outcome={replay.new_outcome} · re_executed=
              {replay.n_re_executed} · from_cache={replay.n_served_from_cache}
              {replay.cache_miss_warnings?.length
                ? ` · cache_miss=[${replay.cache_miss_warnings.join(",")}]`
                : ""}
              {` · ${replay.duration_ms}ms`}
            </p>
          ) : null}
          {error ? (
            <p className="type-meta mt-2 text-[var(--error)]">{error}</p>
          ) : null}
        </div>

        {(diffEntries.length > 0 || (diff?.original?.length ?? 0) > 0) && (
          <div className="shrink-0 border-b border-[var(--line)] px-4 py-3 sm:px-5">
            <p className="type-label">Side-by-side diff</p>
            {diffEntries.length === 0 ? (
              <p className="type-meta mt-2 text-[var(--text-faint)]">
                No response_hash / token / cost changes vs original.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {diffEntries.map(([key, change]) => (
                  <li key={key} className="type-meta text-[var(--text-secondary)]">
                    <span className="text-[var(--text)]">{key}</span>
                    {": "}
                    <span className="text-[var(--text-faint)]">
                      {String((change as { from?: unknown }).from ?? "—")}
                    </span>
                    {" → "}
                    <span className="text-[var(--text)]">
                      {String((change as { to?: unknown }).to ?? "—")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
          <p className="type-label">Forks for this trace</p>
          {forks.length === 0 ? (
            <p className="type-meta mt-2 text-[var(--text-faint)]">
              No forks yet — scrub to a step and replay from there.
            </p>
          ) : (
            <ForkTreeList nodes={forkTree} />
          )}
          <p className="type-meta mt-3 text-[var(--text-faint)]">
            Keys: j/k or ↑/↓ to scrub the run timeline
          </p>
        </div>
      </div>
    </div>
  );
}

type TimeTravelReplayData = {
  replay_id?: string;
  n_re_executed?: number;
  n_served_from_cache?: number;
  new_outcome?: string;
  served_from_cache?: number[];
  re_executed?: number[];
  cache_miss_warnings?: number[];
  tokens_saved?: number;
  cost_saved_usd?: number;
  duration_ms?: number;
  n_steps?: number;
};

type TimeTravelDiffData = {
  original?: Array<{ step_index: number; response_hash?: string }>;
  replay?: Array<{
    step_index: number;
    served_from_cache?: boolean;
    re_executed?: boolean;
    response_hash?: string;
    tokens_used?: number;
    cost_usd?: number;
  }>;
  diff?: Record<string, { from?: unknown; to?: unknown }> | Array<unknown>;
};

function Stat({
  term,
  def,
  warn,
}: {
  term: string;
  def: string;
  warn?: boolean;
}) {
  return (
    <div>
      <dt className="type-label text-[var(--text-faint)]">{term}</dt>
      <dd
        className={cn(
          "type-ui mt-0.5",
          warn ? "text-[var(--error)]" : "text-[var(--text)]",
        )}
      >
        {def}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Notes panel (not a mode)                                            */
/* ------------------------------------------------------------------ */

export function DebuggerNotesPanel({
  notes,
  onChange,
  onClose,
}: {
  notes: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="flex w-full shrink-0 flex-col border-t border-[var(--line)] bg-[var(--bg)] md:w-[20rem] md:border-l md:border-t-0">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5">
        <p className="type-label">Notes</p>
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <label className="flex min-h-0 flex-1 flex-col p-3">
        <span className="sr-only">Investigation notes</span>
        <textarea
          value={notes}
          onChange={(e) => onChange(e.target.value)}
          placeholder="What failed, what you tried…"
          className="min-h-[12rem] w-full flex-1 resize-none rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2.5 font-[family-name:var(--font-sans)] text-[length:var(--fs-body)] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--line-strong)]"
        />
      </label>
    </aside>
  );
}
