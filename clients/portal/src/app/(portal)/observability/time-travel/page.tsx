"use client";

import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { Alert } from "@/components/ui/alert";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { History, Loader2, Play, GitBranch, RotateCcw, Info, Circle, CheckCircle2, Code2 } from "lucide-react";
import { motion } from "framer-motion";

const DEFAULT_EDITED_STATE = `{
  "messages": [
    {"role": "user", "content": "Hello, world!"}
  ]
}`;

interface RecordResult {
  recording_id: string;
  trace_id: string;
  steps: number;
}
interface ForkResult {
  fork_id: string;
  from_step: number;
  new_state: Record<string, unknown>;
}
interface ReplayResult {
  replay_id: string;
  final_state: Record<string, unknown>;
  steps_replayed: number;
  outcome: string;
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function ttRecord(orgId: string, trace_id: string): Promise<RecordResult> {
  return fetchJson<RecordResult>(`/orgs/${orgId}/intelligence/time-travel/record`, {
    method: "POST",
    body: JSON.stringify({ trace_id }) });
}
function ttFork(
  orgId: string,
  recording_id: string,
  at_step: number,
  edited_state: Record<string, unknown>
): Promise<ForkResult> {
  return fetchJson<ForkResult>(`/orgs/${orgId}/intelligence/time-travel/fork`, {
    method: "POST",
    body: JSON.stringify({ recording_id, at_step, edited_state }) });
}
function ttReplay(orgId: string, fork_id: string): Promise<ReplayResult> {
  return fetchJson<ReplayResult>(`/orgs/${orgId}/intelligence/time-travel/replay`, {
    method: "POST",
    body: JSON.stringify({ fork_id }) });
}

export default function TimeTravelPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();

  // Record
  const [traceId, setTraceId] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordedSteps, setRecordedSteps] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);

  // Fork
  const [atStep, setAtStep] = useState(0);
  const [editedState, setEditedState] = useState(DEFAULT_EDITED_STATE);
  const [forkId, setForkId] = useState<string | null>(null);
  const [forkFromStep, setForkFromStep] = useState<number | null>(null);
  const [forksNewState, setForksNewState] = useState<Record<string, unknown> | null>(null);
  const [forking, setForking] = useState(false);

  // Replay
  const [replayId, setReplayId] = useState<string | null>(null);
  const [replayFinalState, setReplayFinalState] = useState<Record<string, unknown> | null>(null);
  const [replayStepsReplayed, setReplayStepsReplayed] = useState<number | null>(null);
  const [replayOutcome, setReplayOutcome] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  const [error, setError] = useState("");

  async function handleRecord() {
    if (!currentOrg) return;
    if (!traceId.trim()) {
      setError("Trace ID is required");
      return;
    }
    setRecording(true);
    setError("");
    try {
      const res = await ttRecord(currentOrg.id, traceId);
      setRecordingId(res.recording_id);
      setRecordedSteps(res.steps);
      setForkId(null);
      setReplayId(null);
      toast.success(`Recorded ${res.steps} steps — ${res.recording_id.slice(0, 12)}…`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Recording failed");
    } finally {
      setRecording(false);
    }
  }

  async function handleFork() {
    if (!currentOrg) return;
    if (!recordingId) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editedState);
    } catch (_e) {
      toast.error("edited_state is not valid JSON");
      return;
    }
    setForking(true);
    setError("");
    try {
      const res = await ttFork(currentOrg.id, recordingId, atStep, parsed);
      setForkId(res.fork_id);
      setForkFromStep(res.from_step);
      setForksNewState(res.new_state);
      setReplayId(null);
      toast.success(`Forked at step ${res.from_step} — ${res.fork_id.slice(0, 12)}…`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Fork failed");
    } finally {
      setForking(false);
    }
  }

  async function handleReplay() {
    if (!currentOrg || !forkId) return;
    setReplaying(true);
    setError("");
    try {
      const res = await ttReplay(currentOrg.id, forkId);
      setReplayId(res.replay_id);
      setReplayFinalState(res.final_state);
      setReplayStepsReplayed(res.steps_replayed);
      setReplayOutcome(res.outcome);
      toast.success(`Replayed ${res.steps_replayed} steps — ${res.outcome}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Replay failed");
    } finally {
      setReplaying(false);
    }
  }

  function resetAll() {
    setRecordingId(null);
    setRecordedSteps(null);
    setForkId(null);
    setForkFromStep(null);
    setForksNewState(null);
    setReplayId(null);
    setReplayFinalState(null);
    setReplayStepsReplayed(null);
    setReplayOutcome(null);
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
          recordingId ? (
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

      {error && (
        <Alert
          variant="error"
          title="Request failed"
          description={error}
          onDismiss={() => setError("")}
        />
      )}

      {/* Stepper indicator */}
      <div className="flex items-center gap-2">
        {[
          { key: "record", label: "Record" },
          { key: "fork", label: "Fork" },
          { key: "replay", label: "Replay" },
        ].map((s, i, arr) => {
          const active =
            s.key === "record" ? !!recordingId : s.key === "fork" ? !!forkId : !!replayId;
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
        active={!recordingId}
        done={!!recordingId}
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
        {recordingId && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 px-3 py-2 rounded-lg bg-[var(--terminal-faint)] text-xs"
          >
            <p className="text-[var(--text-muted)] uppercase tracking-wide text-[10px] mb-0.5">Recording</p>
            <p className="font-mono text-[var(--terminal)]">{recordingId}</p>
            <p className="text-[var(--text-secondary)] mt-1">
              {recordedSteps} step{recordedSteps === 1 ? "" : "s"} captured
            </p>
          </motion.div>
        )}
      </Panel>

      {/* Fork panel */}
      <Panel
        step={2}
        title="Fork"
        icon={GitBranch}
        active={!!recordingId && !forkId}
        done={!!forkId}
        disabled={!recordingId}
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
              Edited state (JSON)
            </label>
            <textarea
              value={editedState}
              onChange={(e) => setEditedState(e.target.value)}
              spellCheck={false}
              aria-label="Edited state JSON"
              className="w-full min-h-[120px] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg font-mono text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>
        </div>
        <button
          onClick={handleFork}
          disabled={forking || !recordingId}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          {forking ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
          Fork
        </button>

        {forkId && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 space-y-2"
          >
            <div className="px-3 py-2 rounded-lg bg-[var(--terminal-faint)] text-xs">
              <p className="text-[var(--text-muted)] uppercase tracking-wide text-[10px] mb-0.5">Fork</p>
              <p className="font-mono text-[var(--terminal)]">{forkId}</p>
              <p className="text-[var(--text-secondary)] mt-1">From step {forkFromStep}</p>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1.5">
                <Code2 className="w-3.5 h-3.5" /> New state
              </summary>
              <pre className="mt-2 text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[200px]">
                {JSON.stringify(forksNewState, null, 2)}
              </pre>
            </details>
          </motion.div>
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

        {replayId && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 space-y-3"
          >
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg bg-[var(--terminal-faint)] text-xs">
              <span className="text-[var(--text-muted)] uppercase tracking-wide text-[10px]">Replay</span>
              <span className="font-mono text-[var(--terminal)]">{replayId}</span>
              <span
                className={cn(
                  "px-2 py-0.5 rounded-full font-medium uppercase tracking-wide text-[10px]",
                  replayOutcome === "success"
                    ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                    : "bg-[var(--error-bg)] text-[var(--error)]"
                )}
              >
                {replayOutcome ?? "unknown"}
              </span>
              <span className="text-[var(--text-secondary)]">
                {replayStepsReplayed} step{replayStepsReplayed === 1 ? "" : "s"}
              </span>
            </div>
            <div>
              <p className="text-[11px] font-medium text-[var(--text-muted)] mb-1.5 uppercase tracking-wide">
                Final state
              </p>
              <pre className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[280px]">
                {JSON.stringify(replayFinalState, null, 2)}
              </pre>
            </div>
          </motion.div>
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
    <motion.div
      initial={false}
      animate={{ opacity: disabled ? 0.5 : 1 }}
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
    </motion.div>
  );
}
