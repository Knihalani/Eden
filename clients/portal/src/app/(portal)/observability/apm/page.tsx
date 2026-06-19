"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { NoOrgState } from "@/components/ui/no-org-state";
import {
  Gauge,
  Loader2,
  Activity,
  ListOrdered,
  Users,
  CheckCircle2,
  XCircle,
  Shuffle,
  AlertOctagon,
  Timer,
  Pin,
  Hash,
  Server,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { motion } from "framer-motion";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface SamplingStats {
  total_evaluated: number;
  kept: number;
  dropped: number;
  by_rule: Record<string, number>;
}
interface EvaluateResult {
  keep: boolean;
  matched_rule: string;
  reason: string;
}
interface StepRecord {
  step_index: number;
  evaluation_score: number | null;
  cost_cents: number;
  duration_ms: number;
}
interface GetStepsResult {
  trace_id: string;
  steps: StepRecord[];
}
interface AgentMetric {
  agent_id: string;
  task_completion_rate: number;
  tool_failure_rate: number;
  avg_iterations_to_success: number;
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function apmSamplingStats(orgId: string): Promise<SamplingStats> {
  return fetchJson<SamplingStats>(`/orgs/${orgId}/intelligence/apm-depth/sampling/stats`);
}
function apmSamplingEvaluate(orgId: string, trace_id: string): Promise<EvaluateResult> {
  return fetchJson<EvaluateResult>(`/orgs/${orgId}/intelligence/apm-depth/sampling/evaluate`, {
    method: "POST",
    body: JSON.stringify({ trace_id }),
  });
}
function apmStampSteps(orgId: string, trace_id: string): Promise<{ trace_id: string; steps_stamped: number }> {
  return fetchJson<{ trace_id: string; steps_stamped: number }>(
    `/orgs/${orgId}/intelligence/apm-depth/steps/stamp`,
    { method: "POST", body: JSON.stringify({ trace_id }) }
  );
}
function apmGetSteps(orgId: string, traceId: string): Promise<GetStepsResult> {
  return fetchJson<GetStepsResult>(`/orgs/${orgId}/intelligence/apm-depth/steps/${traceId}`);
}
function apmAgentMetrics(orgId: string): Promise<{ agents: AgentMetric[] }> {
  return fetchJson<{ agents: AgentMetric[] }>(`/orgs/${orgId}/intelligence/apm-depth/metrics/agents`);
}

const KEEP_RULES = [
  {
    key: "error",
    label: "error",
    icon: AlertOctagon,
    description: "Keep all traces where any step outcome is error / failure / crash. Highest signal for incident detection.",
  },
  {
    key: "slow",
    label: "slow",
    icon: Timer,
    description: "Keep traces whose total duration exceeds the p99 latency threshold (configurable per service).",
  },
  {
    key: "loop",
    label: "loop",
    icon: Shuffle,
    description: "Keep traces that hit the same tool call more than N times — classic agent-loop signature.",
  },
  {
    key: "force_trace",
    label: "force_trace",
    icon: Pin,
    description: "Honor an explicit force_trace=true hint from the SDK — always kept regardless of sampling probability.",
  },
  {
    key: "probabilistic",
    label: "probabilistic",
    icon: Hash,
    description: "Deterministic hash-based probabilistic sample (default 1% of base traffic). Final fallback rule.",
  },
];

export default function ApmPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();

  // Sampling state
  const [samplingStats, setSamplingStats] = useState<SamplingStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [evalTraceId, setEvalTraceId] = useState("");
  const [evalResult, setEvalResult] = useState<EvaluateResult | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  // Steps state
  const [stepTraceId, setStepTraceId] = useState("");
  const [stamping, setStamping] = useState(false);
  const [fetchingSteps, setFetchingSteps] = useState(false);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [stampedCount, setStampedCount] = useState<number | null>(null);

  // Agent metrics state
  const [agentMetrics, setAgentMetrics] = useState<AgentMetric[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  const loadSamplingStats = useCallback(async () => {
    if (!currentOrg) return;
    setStatsLoading(true);
    try {
      const res = await apmSamplingStats(currentOrg.id);
      setSamplingStats(res);
    } catch (err) {
      // silent
    } finally {
      setStatsLoading(false);
    }
  }, [currentOrg]);

  const loadAgentMetrics = useCallback(async () => {
    if (!currentOrg) return;
    setAgentsLoading(true);
    try {
      const res = await apmAgentMetrics(currentOrg.id);
      setAgentMetrics(res.agents);
    } catch (err) {
      // silent
    } finally {
      setAgentsLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    if (currentOrg) {
      loadSamplingStats();
      loadAgentMetrics();
    }
  }, [currentOrg, loadSamplingStats, loadAgentMetrics]);

  async function handleEvaluate() {
    if (!currentOrg) return;
    if (!evalTraceId.trim()) {
      toast.error("Trace ID is required");
      return;
    }
    setEvaluating(true);
    try {
      const res = await apmSamplingEvaluate(currentOrg.id, evalTraceId);
      setEvalResult(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Evaluation failed");
    } finally {
      setEvaluating(false);
    }
  }

  async function handleStamp() {
    if (!currentOrg) return;
    if (!stepTraceId.trim()) {
      toast.error("Trace ID is required");
      return;
    }
    setStamping(true);
    try {
      const res = await apmStampSteps(currentOrg.id, stepTraceId);
      setStampedCount(res.steps_stamped);
      toast.success(`${res.steps_stamped} steps stamped`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stamping failed");
    } finally {
      setStamping(false);
    }
  }

  async function handleGetSteps() {
    if (!currentOrg) return;
    if (!stepTraceId.trim()) {
      toast.error("Trace ID is required");
      return;
    }
    setFetchingSteps(true);
    try {
      const res = await apmGetSteps(currentOrg.id, stepTraceId);
      setSteps(res.steps);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to fetch steps");
      setSteps([]);
    } finally {
      setFetchingSteps(false);
    }
  }

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Gauge}
        feature="APM Depth"
        description="Sampling, per-step evaluation, and agent metrics surface once your org is configured."
      />
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Gauge className="w-6 h-6 text-[var(--accent)]" />
            APM Depth
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Tail sampling, per-step evaluation, and per-agent performance metrics
          </p>
        </div>
      </div>

      <Tabs defaultValue="sampling" className="w-full">
        <TabsList className="bg-[var(--bg-tertiary)] rounded-xl p-1 gap-1">
          <TabsTrigger value="sampling" className="data-[state=active]:bg-[var(--bg-primary)] data-[state=active]:text-[var(--text-primary)]">
            <Activity className="w-3.5 h-3.5 mr-1.5" />
            Sampling
          </TabsTrigger>
          <TabsTrigger value="steps" className="data-[state=active]:bg-[var(--bg-primary)] data-[state=active]:text-[var(--text-primary)]">
            <ListOrdered className="w-3.5 h-3.5 mr-1.5" />
            Per-step
          </TabsTrigger>
          <TabsTrigger value="agents" className="data-[state=active]:bg-[var(--bg-primary)] data-[state=active]:text-[var(--text-primary)]">
            <Users className="w-3.5 h-3.5 mr-1.5" />
            Agent metrics
          </TabsTrigger>
        </TabsList>

        {/* ───── Sampling tab ───── */}
        <TabsContent value="sampling" className="mt-4">
          <motion.div
            key="sampling"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            {/* Stats strip */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatBlock
                label="Total evaluated"
                value={samplingStats?.total_evaluated ?? 0}
                loading={statsLoading}
                accent="neutral"
              />
              <StatBlock
                label="Kept"
                value={samplingStats?.kept ?? 0}
                loading={statsLoading}
                accent="terminal"
              />
              <StatBlock
                label="Dropped"
                value={samplingStats?.dropped ?? 0}
                loading={statsLoading}
                accent="error"
              />
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              {/* Evaluate panel */}
              <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                  <Server className="w-4 h-4 text-[var(--accent)]" />
                  Test evaluation
                </h3>
                <div className="grid sm:grid-cols-[1fr_auto] gap-2">
                  <input
                    type="text"
                    value={evalTraceId}
                    onChange={(e) => setEvalTraceId(e.target.value)}
                    placeholder="trace_abc123…"
                    className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                  />
                  <button
                    onClick={handleEvaluate}
                    disabled={evaluating}
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                  >
                    {evaluating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                    Evaluate
                  </button>
                </div>

                {evalResult && (
                  <div
                    className={cn(
                      "rounded-lg p-3 text-xs space-y-1.5",
                      evalResult.keep
                        ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                        : "bg-[var(--error-bg)] text-[var(--error)]"
                    )}
                  >
                    <p className="flex items-center gap-1.5 font-medium">
                      {evalResult.keep ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                      {evalResult.keep ? "Keep" : "Drop"}
                    </p>
                    <p className="font-mono text-[10px] opacity-80">rule: {evalResult.matched_rule}</p>
                    <p className="text-[11px] opacity-90">{evalResult.reason}</p>
                  </div>
                )}
              </div>

              {/* Keep rules list */}
              <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4">
                <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                  <Pin className="w-4 h-4 text-[var(--accent)]" />
                  5 keep rules
                </h3>
                <ul className="space-y-2">
                  {KEEP_RULES.map((r) => {
                    const Icon = r.icon;
                    return (
                      <li
                        key={r.key}
                        className="flex items-start gap-2.5 px-2.5 py-2 rounded-lg bg-[var(--bg-secondary)]"
                      >
                        <Icon className="w-3.5 h-3.5 mt-0.5 text-[var(--accent)] flex-shrink-0" />
                        <div>
                          <p className="text-xs font-medium text-[var(--text-primary)] font-mono">
                            {r.label}
                            {samplingStats?.by_rule?.[r.key] !== undefined && (
                              <span className="ml-2 text-[10px] text-[var(--text-muted)] font-sans">
                                ({samplingStats.by_rule[r.key]} kept)
                              </span>
                            )}
                          </p>
                          <p className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-relaxed">
                            {r.description}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </motion.div>
        </TabsContent>

        {/* ───── Per-step tab ───── */}
        <TabsContent value="steps" className="mt-4">
          <motion.div
            key="steps"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 space-y-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <ListOrdered className="w-4 h-4 text-[var(--accent)]" />
                Per-step evaluation
              </h3>
              <div className="grid sm:grid-cols-[1fr_auto_auto] gap-2">
                <input
                  type="text"
                  value={stepTraceId}
                  onChange={(e) => setStepTraceId(e.target.value)}
                  placeholder="trace_abc123…"
                  className="w-full px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                />
                <button
                  onClick={handleStamp}
                  disabled={stamping}
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors"
                >
                  {stamping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pin className="w-3.5 h-3.5" />}
                  Stamp
                </button>
                <button
                  onClick={handleGetSteps}
                  disabled={fetchingSteps}
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                >
                  {fetchingSteps ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ListOrdered className="w-3.5 h-3.5" />}
                  Get steps
                </button>
              </div>
              {stampedCount !== null && (
                <p className="text-[11px] text-[var(--text-muted)]">
                  Last stamp: {stampedCount} step{stampedCount === 1 ? "" : "s"}
                </p>
              )}
            </div>

            {fetchingSteps && steps.length === 0 ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
              </div>
            ) : steps.length === 0 ? (
              <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl py-10 text-center">
                <ListOrdered className="w-10 h-10 mx-auto mb-2 text-[var(--text-muted)] opacity-40" />
                <p className="text-sm text-[var(--text-muted)]">No steps yet. Stamp and fetch to see results.</p>
              </div>
            ) : (
              <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                        <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Step</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Score</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Cost (¢)</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Duration (ms)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)]">
                      {steps.map((s) => (
                        <tr key={s.step_index} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                          <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-primary)]">
                            {s.step_index}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-secondary)]">
                            {s.evaluation_score !== null ? s.evaluation_score.toFixed(3) : "—"}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-secondary)]">
                            {s.cost_cents.toFixed(2)}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-secondary)]">
                            {s.duration_ms.toFixed(1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </motion.div>
        </TabsContent>

        {/* ───── Agent metrics tab ───── */}
        <TabsContent value="agents" className="mt-4">
          <motion.div
            key="agents"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Users className="w-4 h-4 text-[var(--accent)]" />
                Per-agent performance
              </h3>
              <button
                onClick={loadAgentMetrics}
                disabled={agentsLoading}
                className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                {agentsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Refresh"}
              </button>
            </div>

            {agentsLoading && agentMetrics.length === 0 ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
              </div>
            ) : agentMetrics.length === 0 ? (
              <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl py-10 text-center">
                <Users className="w-10 h-10 mx-auto mb-2 text-[var(--text-muted)] opacity-40" />
                <p className="text-sm text-[var(--text-muted)]">No agent metrics yet — start running agents to see data.</p>
              </div>
            ) : (
              <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                        <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Agent</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Task completion</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Tool failure</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Avg iter / success</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)]">
                      {agentMetrics.map((a) => (
                        <tr key={a.agent_id} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                          <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-primary)]">
                            {a.agent_id}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs">
                            <RateBar value={a.task_completion_rate} kind="good" />
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs">
                            <RateBar value={a.tool_failure_rate} kind="bad" />
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-secondary)]">
                            {a.avg_iterations_to_success.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </motion.div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatBlock({
  label,
  value,
  loading,
  accent,
}: {
  label: string;
  value: number;
  loading: boolean;
  accent: "neutral" | "terminal" | "error";
}) {
  const accentClass =
    accent === "terminal"
      ? "text-[var(--terminal)]"
      : accent === "error"
      ? "text-[var(--error)]"
      : "text-[var(--text-primary)]";
  return (
    <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      {loading ? (
        <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)] mt-1" />
      ) : (
        <p className={cn("text-2xl font-bold font-mono mt-1", accentClass)}>
          {value.toLocaleString()}
        </p>
      )}
    </div>
  );
}

function RateBar({ value, kind }: { value: number; kind: "good" | "bad" }) {
  const pct = Math.max(0, Math.min(1, value));
  const color =
    kind === "good"
      ? pct > 0.7
        ? "bg-[var(--terminal)]"
        : pct > 0.4
        ? "bg-[var(--warning)]"
        : "bg-[var(--error)]"
      : pct > 0.5
      ? "bg-[var(--error)]"
      : pct > 0.2
      ? "bg-[var(--warning)]"
      : "bg-[var(--terminal)]";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="text-[11px] text-[var(--text-secondary)]">{(pct * 100).toFixed(1)}%</span>
    </div>
  );
}
