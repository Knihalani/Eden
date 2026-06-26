"use client";

import { useState, useEffect, useCallback } from "react";
import { usePolling } from "@/hooks/use-polling";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  Pause,
  Play,
  SkipForward,
  MessageSquare,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Activity,
  Terminal,
  Zap,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Send,
} from "lucide-react";

interface HILTState {
  job_id: string;
  state: string;
  paused_at: string | null;
  resumed_at: string | null;
  waiting_for: string | null;
  current_step: number | null;
  total_steps: number | null;
  pending_command_count: number;
  history: Array<Record<string, unknown>>;
  last_updated: string;
}

interface HILTPanelProps {
  jobId: string;
  jobStatus: string;
}

type CommandType = "pause" | "resume" | "step" | "inject" | "approve" | "reject" | "rewind" | "status";

const STATE_LABELS: Record<string, { label: string; color: string; bg: string; icon: typeof Activity }> = {
  idle: { label: "Idle", color: "text-[var(--text-faint)]", bg: "bg-[var(--bg-tertiary)]", icon: Activity },
  running: { label: "Running", color: "text-[var(--cat-success-fg)]", bg: "bg-[var(--terminal-faint)]", icon: Play },
  paused: { label: "Paused", color: "text-[var(--cat-warning-fg)]", bg: "bg-[var(--cat-warning-dim)]", icon: Pause },
  waiting_approval: { label: "Waiting Approval", color: "text-[var(--cat-info-fg)]", bg: "bg-[var(--cat-info-dim)]", icon: Clock },
  stepping: { label: "Stepping", color: "text-[var(--cat-purple-fg)]", bg: "bg-[var(--cat-purple-dim)]", icon: SkipForward },
  injected: { label: "Injected", color: "text-teal-400", bg: "bg-teal-400/10", icon: MessageSquare },
};

function getStateConfig(state: string) {
  return STATE_LABELS[state] || { label: state, color: "text-[var(--text-faint)]", bg: "bg-[var(--bg-tertiary)]", icon: Activity };
}

export function HILTPanel({ jobId, jobStatus }: HILTPanelProps) {
  const [hiltState, setHiltState] = useState<HILTState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [injectMessage, setInjectMessage] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [commandLoading, setCommandLoading] = useState<string | null>(null);

  const isTerminal = ["completed", "failed", "cancelled"].includes(jobStatus);
  const canControl = !isTerminal && jobStatus !== "pending";

  const fetchState = useCallback(async () => {
    if (!canControl) return;
    try {
      const state = await api.getHILTState(jobId);
      setHiltState(state);
      setError(null);
    } catch (e) {
      // Silently fail on initial load — HILT may not be initialized yet
    }
  }, [jobId, canControl]);

  // Cost-safe polling — pauses when the tab is hidden, backs off on
  // errors, bails on 401/403. Replaces a raw setInterval that would
  // have kept firing through all three failure modes. June 2026
  // cost-pass.
  usePolling({
    fetch: fetchState,
    intervalMs: 3_000,
    deps: [fetchState],
  });

  const sendCommand = async (command: CommandType, payload?: Record<string, unknown>) => {
    setCommandLoading(command);
    setLastCommand(command);
    setError(null);
    try {
      const result = await api.sendHILTCommand(jobId, command, payload);
      if (result.state) {
        setHiltState(result.state as unknown as HILTState);
      }
      if (result.status === "error") {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Command failed");
    } finally {
      setCommandLoading(null);
    }
  };

  const stateConfig = getStateConfig(hiltState?.state || "idle");
  const StateIcon = stateConfig.icon;

  if (isTerminal) {
    return (
      <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 text-[var(--text-faint)]">
          <Activity className="w-4 h-4" />
          <span className="text-xs font-medium">Human-in-the-Loop controls are unavailable for terminal jobs</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* State Banner */}
      <div className={cn("flex items-center gap-3 p-3 rounded-lg border", stateConfig.bg, "border-[var(--border-subtle)]")}>
        <div className={cn("p-2 rounded-md", stateConfig.bg)}>
          <StateIcon className={cn("w-4 h-4", stateConfig.color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("text-sm font-semibold", stateConfig.color)}>{stateConfig.label}</span>
            {hiltState?.pending_command_count ? (
              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-[var(--border-subtle)] text-[var(--text-muted)] rounded">
                {hiltState.pending_command_count} pending
              </span>
            ) : null}
          </div>
          {hiltState?.waiting_for && (
            <p className="text-xs text-[var(--text-faint)] mt-0.5">Waiting for: {hiltState.waiting_for}</p>
          )}
          {hiltState && hiltState.current_step !== null && hiltState.total_steps !== null && (
            <p className="text-xs text-[var(--text-faint)] mt-0.5">
              Step {hiltState.current_step} / {hiltState.total_steps}
            </p>
          )}
        </div>
        <button
          onClick={fetchState}
          className="p-1.5 text-[var(--text-faint)] hover:text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] rounded-md transition-colors"
          title="Refresh state"
        >
          <Activity className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="p-2.5 rounded-lg bg-[var(--cat-danger-dim)] border border-[var(--cat-danger-fg)]/20 text-xs text-[var(--cat-danger-fg)] flex items-center gap-2"
          >
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Control Buttons */}
      <div className="grid grid-cols-3 gap-2">
        <HILTButton
          icon={Pause}
          label="Pause"
          onClick={() => sendCommand("pause")}
          loading={commandLoading === "pause"}
          active={hiltState?.state === "paused"}
          disabled={!canControl}
          variant="amber"
        />
        <HILTButton
          icon={Play}
          label="Resume"
          onClick={() => sendCommand("resume")}
          loading={commandLoading === "resume"}
          active={hiltState?.state === "running"}
          disabled={!canControl}
          variant="emerald"
        />
        <HILTButton
          icon={SkipForward}
          label="Step"
          onClick={() => sendCommand("step")}
          loading={commandLoading === "step"}
          active={hiltState?.state === "stepping"}
          disabled={!canControl}
          variant="violet"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <HILTButton
          icon={CheckCircle2}
          label="Approve"
          onClick={() => sendCommand("approve")}
          loading={commandLoading === "approve"}
          disabled={!canControl}
          variant="sky"
        />
        <HILTButton
          icon={XCircle}
          label="Reject"
          onClick={() => sendCommand("reject")}
          loading={commandLoading === "reject"}
          disabled={!canControl}
          variant="rose"
        />
      </div>

      {/* Inject Message */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-[var(--text-faint)] uppercase tracking-wider flex items-center gap-1.5">
          <MessageSquare className="w-3 h-3" />
          Inject Message
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={injectMessage}
            onChange={(e) => setInjectMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && injectMessage.trim()) {
                sendCommand("inject", { message: injectMessage.trim(), target: "context" });
                setInjectMessage("");
              }
            }}
            placeholder="Type a message to inject into the agent context..."
            disabled={!canControl || commandLoading === "inject"}
            className={cn(
              "flex-1 px-3 py-2 text-xs rounded-lg bg-[var(--bg-tertiary)] border border-white/10",
              "text-[var(--text-muted)] placeholder:text-[var(--text-faint)]",
              "focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/10",
              "disabled:opacity-40"
            )}
          />
          <button
            onClick={() => {
              if (injectMessage.trim()) {
                sendCommand("inject", { message: injectMessage.trim(), target: "context" });
                setInjectMessage("");
              }
            }}
            disabled={!canControl || !injectMessage.trim() || commandLoading === "inject"}
            className={cn(
              "px-3 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5",
              injectMessage.trim() && canControl
                ? "bg-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--border-default)]"
                : "bg-[var(--bg-tertiary)] text-[var(--text-faint)] cursor-not-allowed"
            )}
          >
            {commandLoading === "inject" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            Inject
          </button>
        </div>
      </div>

      {/* Command History */}
      {hiltState && hiltState.history.length > 0 && (
        <div>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-1.5 text-xs text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors w-full"
          >
            <Terminal className="w-3 h-3" />
            Command History ({hiltState.history.length})
            {showHistory ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          <AnimatePresence>
            {showHistory && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                  {hiltState.history.slice(-10).reverse().map((entry, i) => {
                    const cmd = (entry.command as string) || "unknown";
                    const ts = (entry.timestamp as string) || "";
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--bg-tertiary)] text-xs"
                      >
                        <span className="text-[10px] text-[var(--text-faint)] font-mono">
                          {ts ? new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }) : "—"}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] font-medium text-[10px] uppercase">
                          {cmd}
                        </span>
                        <span className="text-[var(--text-faint)] truncate">
                          {(entry.user_id as string) || "system"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function HILTButton({
  icon: Icon,
  label,
  onClick,
  loading,
  active,
  disabled,
  variant,
}: {
  icon: typeof Pause;
  label: string;
  onClick: () => void;
  loading: boolean;
  active?: boolean;
  disabled: boolean;
  variant: "amber" | "emerald" | "violet" | "sky" | "rose";
}) {
  const variantStyles: Record<string, { active: string; inactive: string; icon: string }> = {
    amber: { active: "bg-[var(--cat-warning-dim)] text-[var(--cat-warning-fg)] border-[var(--cat-warning-fg)]/30", inactive: "bg-[var(--bg-tertiary)] text-[var(--text-faint)] border-transparent hover:bg-[var(--cat-warning-dim)] hover:text-[var(--cat-warning-fg)]/70", icon: "text-[var(--cat-warning-fg)]" },
    emerald: { active: "bg-[var(--terminal-faint)] text-[var(--cat-success-fg)] border-[var(--cat-success-fg)]/30", inactive: "bg-[var(--bg-tertiary)] text-[var(--text-faint)] border-transparent hover:bg-[var(--terminal-faint)] hover:text-[var(--cat-success-fg)]/70", icon: "text-[var(--cat-success-fg)]" },
    violet: { active: "bg-[var(--cat-purple-dim)] text-[var(--cat-purple-fg)] border-[var(--cat-purple-fg)]/30", inactive: "bg-[var(--bg-tertiary)] text-[var(--text-faint)] border-transparent hover:bg-[var(--cat-purple-dim)] hover:text-[var(--cat-purple-fg)]/70", icon: "text-[var(--cat-purple-fg)]" },
    sky: { active: "bg-[var(--cat-info-dim)] text-[var(--cat-info-fg)] border-[var(--cat-info-fg)]/30", inactive: "bg-[var(--bg-tertiary)] text-[var(--text-faint)] border-transparent hover:bg-[var(--cat-info-dim)] hover:text-[var(--cat-info-fg)]/70", icon: "text-[var(--cat-info-fg)]" },
    rose: { active: "bg-[var(--cat-danger-dim)] text-[var(--cat-danger-fg)] border-[var(--cat-danger-fg)]/30", inactive: "bg-[var(--bg-tertiary)] text-[var(--text-faint)] border-transparent hover:bg-[var(--cat-danger-dim)] hover:text-[var(--cat-danger-fg)]/70", icon: "text-[var(--cat-danger-fg)]" },
  };

  const style = variantStyles[variant];

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        "flex flex-col items-center gap-1.5 px-3 py-2.5 rounded-lg border text-xs font-medium transition-all",
        active ? style.active : style.inactive,
        disabled && "opacity-30 cursor-not-allowed hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-faint)]"
      )}
    >
      {loading ? (
        <Loader2 className={cn("w-4 h-4 animate-spin", active ? style.icon : "text-[var(--text-faint)]")} />
      ) : (
        <Icon className={cn("w-4 h-4", active ? style.icon : "text-[var(--text-faint)]")} />
      )}
      {label}
    </button>
  );
}
