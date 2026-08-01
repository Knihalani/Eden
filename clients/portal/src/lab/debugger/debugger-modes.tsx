"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Play } from "lucide-react";
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
}: {
  session: DebuggerSessionFixture;
  leftTraceId: string;
  rightTraceId: string;
  onLeftChange: (id: string) => void;
  onRightChange: (id: string) => void;
  leftTrace?: TraceFixture | null;
  rightTrace?: TraceFixture | null;
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

      {!left || !right ? (
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
}: {
  session: DebuggerSessionFixture;
  focusSpanId?: string | null;
  onFocusSpan: (spanId: string | null) => void;
  sourceTrace?: TraceFixture | null;
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
            focusStepId={snap.step.id}
            defaultOpenIds={[snap.step.id]}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Time travel — Cat 20 fork / live replay / diff                      */
/* ------------------------------------------------------------------ */

export function DebuggerTimeTravelView({
  session,
  orgId,
  sourceTrace,
}: {
  session: DebuggerSessionFixture;
  orgId: string | null;
  sourceTrace?: TraceFixture | null;
}) {
  const checkpoints = sessionCheckpoints(session, sourceTrace);
  const [forkAt, setForkAt] = useState(0);
  const [promptEdit, setPromptEdit] = useState("");
  const [busy, setBusy] = useState(false);
  const [forkId, setForkId] = useState<string | null>(null);
  const [replayId, setReplayId] = useState<string | null>(null);
  const [forks, setForks] = useState<Array<Record<string, unknown>>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffSummary, setDiffSummary] = useState<string | null>(null);

  const refreshForks = async () => {
    if (!orgId || !session.sourceTraceId) return;
    try {
      const { timeTravelApi } = await import("@/lib/api/resources");
      const res = await timeTravelApi.listForks(orgId, session.sourceTraceId);
      const data = (res as { data?: { forks?: Array<Record<string, unknown>> } })
        ?.data;
      setForks(Array.isArray(data?.forks) ? data!.forks! : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to list forks");
    }
  };

  useEffect(() => {
    void refreshForks();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per session/org
  }, [orgId, session.sourceTraceId]);

  const onForkAndReplay = async () => {
    if (!orgId || !session.sourceTraceId) {
      setError("Missing org or source trace.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    setDiffSummary(null);
    try {
      const { timeTravelApi } = await import("@/lib/api/resources");
      const edits: Record<string, unknown> = {};
      if (promptEdit.trim()) {
        edits[`step_${forkAt}.prompt`] = promptEdit.trim();
      }
      const forkRes = await timeTravelApi.fork(orgId, {
        parent_trace_id: session.sourceTraceId,
        fork_at_step: forkAt,
        name: `Debugger fork @ ${forkAt}`,
        edits,
      });
      const newForkId = String(
        (forkRes as { data?: { fork_id?: string } })?.data?.fork_id || "",
      );
      if (!newForkId) {
        throw new Error("Fork response missing fork_id");
      }
      setForkId(newForkId);
      setStatus(`Forked ${newForkId}`);

      const replayRes = await timeTravelApi.replay(orgId, {
        fork_id: newForkId,
        edits,
      });
      const replayData = (replayRes as { data?: TimeTravelReplayShape })?.data;
      const newReplayId = String(replayData?.replay_id || "");
      setReplayId(newReplayId || null);
      const nRe = Number(replayData?.n_re_executed ?? 0);
      const nCache = Number(replayData?.n_served_from_cache ?? 0);
      const outcome = String(replayData?.new_outcome || "unknown");
      setStatus(
        `Replay ${newReplayId || "—"} · outcome=${outcome} · re_executed=${nRe} · from_cache=${nCache}`,
      );

      if (newForkId && newReplayId) {
        try {
          const diffRes = await timeTravelApi.diff(orgId, newForkId, newReplayId);
          const d = (diffRes as { data?: { diff?: unknown } })?.data;
          const diffArr = Array.isArray(d?.diff) ? d!.diff! : [];
          setDiffSummary(
            diffArr.length
              ? `${diffArr.length} field change(s) vs original`
              : "No field-level diffs (identical hashes or cannot_replay on historical steps).",
          );
        } catch (diffErr) {
          setDiffSummary(
            diffErr instanceof Error
              ? `Diff unavailable: ${diffErr.message}`
              : "Diff unavailable",
          );
        }
      }
      await refreshForks();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Time travel failed";
      setError(
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3 sm:px-5">
      <div>
        <p className="type-label">Cat 20 time travel</p>
        <p className="type-meta mt-1 text-[var(--text-secondary)]">
          Fork this trace at a step, optionally edit the prompt, and live-replay
          through the AI gateway. Steps before the fork may serve from{" "}
          <code className="type-meta">cache_lookups</code>. Historical rows
          without recorded prompt content return honest{" "}
          <code className="type-meta">cannot_replay</code>.
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="type-label">Fork at step</span>
        <select
          className="ds-input"
          value={forkAt}
          onChange={(e) => setForkAt(Number(e.target.value) || 0)}
        >
          {(checkpoints.length ? checkpoints : [{ id: "0", label: "Step 0" }]).map(
            (cp, i) => (
              <option key={cp.id} value={i}>
                {i}: {cp.label}
              </option>
            ),
          )}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="type-label">Prompt edit (optional)</span>
        <textarea
          className="ds-input min-h-[5rem]"
          placeholder="step_N.prompt override"
          value={promptEdit}
          onChange={(e) => setPromptEdit(e.target.value)}
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm"
          disabled={busy || !orgId}
          onClick={() => void onForkAndReplay()}
        >
          {busy ? "Running…" : "Fork + live replay"}
        </button>
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          disabled={busy || !orgId}
          onClick={() => void refreshForks()}
        >
          Refresh forks
        </button>
      </div>

      {status ? (
        <p className="type-meta text-[var(--text-secondary)]">{status}</p>
      ) : null}
      {diffSummary ? (
        <p className="type-meta text-[var(--text-secondary)]">{diffSummary}</p>
      ) : null}
      {error ? <p className="type-meta text-[var(--error)]">{error}</p> : null}
      {forkId ? (
        <p className="type-meta text-[var(--text-faint)]">
          fork={forkId}
          {replayId ? ` · replay=${replayId}` : ""}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--line)] pt-3">
        <p className="type-label">Forks for this trace</p>
        {forks.length === 0 ? (
          <p className="type-meta mt-2 text-[var(--text-faint)]">No forks yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {forks.map((f) => (
              <li
                key={String(f.fork_id || f.id)}
                className="type-meta rounded-[var(--radius)] border border-[var(--line)] px-3 py-2"
              >
                <span className="text-[var(--text)]">
                  {String(f.fork_id || f.id)}
                </span>
                {" · step "}
                {String(f.fork_at_step ?? "?")}
                {f.name ? ` · ${String(f.name)}` : ""}
                {f.last_replay_outcome
                  ? ` · last=${String(f.last_replay_outcome)}`
                  : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type TimeTravelReplayShape = {
  replay_id?: string;
  n_re_executed?: number;
  n_served_from_cache?: number;
  new_outcome?: string;
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

/** @deprecated — notes are a panel now */
export function DebuggerNotesView(props: {
  notes: string;
  onChange: (v: string) => void;
}) {
  return (
    <DebuggerNotesPanel
      notes={props.notes}
      onChange={props.onChange}
      onClose={() => undefined}
    />
  );
}
