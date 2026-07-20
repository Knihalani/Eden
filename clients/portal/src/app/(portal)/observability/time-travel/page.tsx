"use client";

import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import {
  timeTravelApi,
  type TimeTravelEnvelope,
  type TimeTravelForkData,
  type TimeTravelReplayData,
} from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { History, Loader2, Play, GitBranch, RotateCcw, Info, Circle, CheckCircle2, Code2 } from "lucide-react";
import { errorFromCaught } from "@/lib/safe-error-message";

/** Default empty edits — BE expects ``step_<n>.<key>`` dotted paths. */
const DEFAULT_EDITS = `{}`;

function unwrapEnvelope<T>(
  res: TimeTravelEnvelope<T>,
  fallback: string,
): T {
  if (res.status === "not_implemented" || res.data == null) {
    throw new Error(res.message || fallback);
  }
  return res.data;
}

export default function TimeTravelPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();

  // Record
  const [traceId, setTraceId] = useState("");
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  // Fork
  const [atStep, setAtStep] = useState(0);
  const [editsJson, setEditsJson] = useState(DEFAULT_EDITS);
  const [forkId, setForkId] = useState<string | null>(null);
  const [forkAtStep, setForkAtStep] = useState<number | null>(null);
  const [forkMeta, setForkMeta] = useState<TimeTravelForkData | null>(null);
  const [forking, setForking] = useState(false);

  // Replay
  const [replayId, setReplayId] = useState<string | null>(null);
  const [replayData, setReplayData] = useState<TimeTravelReplayData | null>(null);
  const [replaying, setReplaying] = useState(false);

  const [error, setError] = useState("");
  const [lastAction, setLastAction] = useState<"record" | "fork" | "replay" | null>(null);

  async function handleRecord() {
    if (!currentOrg) return;
    setLastAction("record");
    if (!traceId.trim()) {
      setError("Trace ID is required");
      return;
    }
    setRecording(true);
    setError("");
    try {
      const res = await timeTravelApi.record(currentOrg.id, {
        trace_id: traceId.trim(),
      });
      setSnapshotId(res.snapshot_id);
      setForkId(null);
      setForkMeta(null);
      setReplayId(null);
      setReplayData(null);
      toast.success(`Snapshot ${res.snapshot_id.slice(0, 12)}…`);
    } catch (err) {
      const msg = errorFromCaught(err, "Recording failed");
      setError(msg);
      toast.error(msg);
    } finally {
      setRecording(false);
    }
  }

  async function handleFork() {
    if (!currentOrg) return;
    setLastAction("fork");
    if (!traceId.trim()) {
      setError("Trace ID is required");
      return;
    }
    let edits: Record<string, unknown>;
    try {
      edits = JSON.parse(editsJson);
      if (edits === null || typeof edits !== "object" || Array.isArray(edits)) {
        throw new Error("edits must be a JSON object");
      }
    } catch (_e) {
      toast.error("edits is not valid JSON object (expected step_<n>.<key> keys)");
      return;
    }
    setForking(true);
    setError("");
    try {
      const res = await timeTravelApi.fork(currentOrg.id, {
        parent_trace_id: traceId.trim(),
        fork_at_step: atStep,
        name: `fork @ step ${atStep}`,
        parent_fork_id: snapshotId,
        edits,
      });
      const data = unwrapEnvelope(res, "Fork failed");
      setForkId(data.fork_id);
      setForkAtStep(data.fork_at_step);
      setForkMeta(data);
      setReplayId(null);
      setReplayData(null);
      toast.success(`Forked at step ${data.fork_at_step} — ${data.fork_id.slice(0, 12)}…`);
    } catch (err) {
      const msg = errorFromCaught(err, "Fork failed");
      setError(msg);
      toast.error(msg);
    } finally {
      setForking(false);
    }
  }

  async function handleReplay() {
    if (!currentOrg || !forkId) return;
    setLastAction("replay");
    setReplaying(true);
    setError("");
    try {
      const res = await timeTravelApi.replay(currentOrg.id, { fork_id: forkId });
      const data = unwrapEnvelope(res, "Replay failed");
      setReplayId(data.replay_id);
      setReplayData(data);
      if (res.message) {
        toast.success(`Replayed — ${data.new_outcome} (${res.message})`);
      } else {
        toast.success(`Replayed ${data.n_steps} steps — ${data.new_outcome}`);
      }
    } catch (err) {
      const msg = errorFromCaught(err, "Replay failed");
      setError(msg);
      toast.error(msg);
    } finally {
      setReplaying(false);
    }
  }

  function retryLast() {
    if (lastAction === "record") void handleRecord();
    else if (lastAction === "fork") void handleFork();
    else if (lastAction === "replay") void handleReplay();
  }

  function resetAll() {
    setSnapshotId(null);
    setForkId(null);
    setForkAtStep(null);
    setForkMeta(null);
    setReplayId(null);
    setReplayData(null);
  }

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={History}
        feature="Time-Travel Debugging"
        description="Record, fork, and replay trace state at any step — non-destructive debugging once your org is configured."
      />
    );
  }

  return (
    <PageContent>
      <PageHeader
        title="Time-Travel"
        subtitle="Replay traces with point-in-time state restoration"
        icon={History}
        eyebrow="Observe"
        actions={
          snapshotId ? (
            <button
              onClick={resetAll}
              aria-label="Reset all time-travel state"
              className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              Reset
            </button>
          ) : undefined
        }
      />

      <div className="bg-[var(--accent-faint)]/50 border border-[var(--accent)]/20 rounded-xl px-4 py-2.5 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <Info className="w-3.5 h-3.5 text-[var(--accent)] flex-shrink-0" />
        Fork at any step, edit state, replay from that point. Non-destructive — original trace unchanged.
      </div>

      {error ? (
        <ErrorState
          title="Could not complete time-travel step"
          message={error}
          action={
            lastAction ? (
              <Button size="sm" variant="outline" onClick={retryLast}>
                Try again
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {/* Stepper indicator */}
      <div className="flex items-center gap-2">
        {[
          { key: "record", label: "Record" },
          { key: "fork", label: "Fork" },
          { key: "replay", label: "Replay" },
        ].map((s, i, arr) => {
          const active =
            s.key === "record" ? !!snapshotId : s.key === "fork" ? !!forkId : !!replayId;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <div
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
                  active
                    ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                    : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                )}
              >
                {active ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}
                {i + 1}. {s.label}
              </div>
              {i < arr.length - 1 && <div className="w-6 h-px bg-[var(--border-default)]" />}
            </div>
          );
        })}
      </div>

      {/* Record panel */}
      <Panel
        step={1}
        title="Record"
        icon={History}
        active={!snapshotId}
        done={!!snapshotId}
      >
        <div className="grid sm:grid-cols-[1fr_auto] gap-3">
          <div>
            <label className="text-[11px] font-medium text-[var(--text-muted)] mb-1 block uppercase tracking-wide">
              Trace ID
            </label>
            <input
              type="text"
              value={traceId}
              onChange={(e) => setTraceId(e.target.value)}
              placeholder="trace_abc123…"
              aria-label="Trace ID to record"
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
          <button
            onClick={handleRecord}
            disabled={recording}
            className="self-end inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {recording ? <Loader2 className="w-4 h-4 animate-spin" /> : <History className="w-4 h-4" />}
            Record
          </button>
        </div>
        {snapshotId && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-[var(--terminal-faint)] text-xs">
            <p className="text-[var(--text-muted)] uppercase tracking-wide text-[10px] mb-0.5">Snapshot</p>
            <p className="font-mono text-[var(--terminal)]">{snapshotId}</p>
          </div>
        )}
      </Panel>

      {/* Fork panel */}
      <Panel
        step={2}
        title="Fork"
        icon={GitBranch}
        active={!!snapshotId && !forkId}
        done={!!forkId}
        disabled={!snapshotId}
      >
        <div className="grid sm:grid-cols-[160px_1fr] gap-3 mb-3">
          <div>
            <label className="text-[11px] font-medium text-[var(--text-muted)] mb-1 block uppercase tracking-wide">
              Step index
            </label>
            <input
              type="number"
              min={0}
              value={atStep}
              onChange={(e) => setAtStep(Number(e.target.value))}
              aria-label="Step index to fork at"
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-[var(--text-muted)] mb-1 block uppercase tracking-wide">
              Edits JSON (step_N.key)
            </label>
            <textarea
              value={editsJson}
              onChange={(e) => setEditsJson(e.target.value)}
              spellCheck={false}
              aria-label="Edits JSON"
              placeholder='{"step_0.system_prompt": "..."}'
              className="w-full min-h-[120px] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg font-mono text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>
        </div>
        <button
          onClick={handleFork}
          disabled={forking || !snapshotId}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          {forking ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
          Fork
        </button>

        {forkId && (
          <div className="mt-3 space-y-2">
            <div className="px-3 py-2 rounded-lg bg-[var(--terminal-faint)] text-xs">
              <p className="text-[var(--text-muted)] uppercase tracking-wide text-[10px] mb-0.5">Fork</p>
              <p className="font-mono text-[var(--terminal)]">{forkId}</p>
              <p className="text-[var(--text-secondary)] mt-1">
                At step {forkAtStep}
                {forkMeta ? ` · ${forkMeta.n_parent_steps} parent steps` : ""}
              </p>
            </div>
            {forkMeta && (
              <details className="text-xs">
                <summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1.5">
                  <Code2 className="w-3.5 h-3.5" /> Fork metadata
                </summary>
                <pre className="mt-2 text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[200px]">
                  {JSON.stringify(forkMeta, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </Panel>

      {/* Replay panel */}
      <Panel
        step={3}
        title="Replay"
        icon={Play}
        active={!!forkId && !replayId}
        done={!!replayId}
        disabled={!forkId}
      >
        <button
          onClick={handleReplay}
          disabled={replaying || !forkId}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          {replaying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Replay
        </button>

        {replayId && replayData && (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg bg-[var(--terminal-faint)] text-xs">
              <span className="text-[var(--text-muted)] uppercase tracking-wide text-[10px]">Replay</span>
              <span className="font-mono text-[var(--terminal)]">{replayId}</span>
              <span
                className={cn(
                  "px-2 py-0.5 rounded-full font-medium uppercase tracking-wide text-[10px]",
                  replayData.new_outcome === "success"
                    ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                    : "bg-[var(--error-bg)] text-[var(--error)]"
                )}
              >
                {replayData.new_outcome}
              </span>
              <span className="text-[var(--text-secondary)]">
                {replayData.n_steps} step{replayData.n_steps === 1 ? "" : "s"}
                {" · "}
                {replayData.n_served_from_cache} cached
                {" · "}
                {replayData.n_re_executed} live
              </span>
            </div>
            <div>
              <p className="text-[11px] font-medium text-[var(--text-muted)] mb-1.5 uppercase tracking-wide">
                Replay result
              </p>
              <pre className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[280px]">
                {JSON.stringify(replayData, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Panel>
    </PageContent>
  );
}

function Panel({
  step,
  title,
  icon: Icon,
  active,
  done,
  disabled,
  children }: {
  step: number;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  done: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 space-y-2",
        active && "ring-1 ring-[var(--accent)]/30"
      )}
    >
      <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
        <span
          className={cn(
            "w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center flex-shrink-0",
            done
              ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
              : "bg-[var(--accent-faint)] text-[var(--accent)]"
          )}
        >
          {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : step}
        </span>
        <Icon className="w-4 h-4 text-[var(--accent)]" />
        {title}
      </h3>
      <div className={cn(disabled && "pointer-events-none")}>{children}</div>
    </div>
  );
}
