/**
 * Production A/B compare fixtures — traffic-split experiments (ship decision).
 * Distinct from Debugger Compare (trace fork) and Evals Results (offline cases).
 */

import { agentById } from "@/lab/fixtures/agents";
import { catalogCompareExperiments } from "@/lib/portal-catalog";

export type AbStatus = "active" | "stopped" | "winner_detected";
export type AbRecommendation =
  | "ship"
  | "dont_ship"
  | "ship_with_monitoring"
  | "need_more_data";
export type AbArmKey = "control" | "treatment";
export type AbPrimaryMetric = "stumble" | "score" | "cost" | "latency";
export type AbSampleGrade = "improve" | "regress" | "tradeoff" | "tie";
export type AbLayout = "overview" | "samples" | "timeline";

export type AbArm = {
  key: AbArmKey;
  label: string;
  versionKey: string;
  weight: number;
  nTraces: number;
  stumbleRate: number;
  avgScore: number;
  costUsdPerTrace: number;
  latencyP95Ms: number;
};

export type AbMetricPoint = {
  t: string;
  control: number;
  treatment: number;
};

export type AbSample = {
  id: string;
  experimentId: string;
  input: string;
  grade: AbSampleGrade;
  controlTraceId: string;
  treatmentTraceId: string;
  controlOutput: string;
  treatmentOutput: string;
  controlScore: number;
  treatmentScore: number;
  judge?: string;
  rationale?: string;
};

export type AbExperimentFixture = {
  id: string;
  name: string;
  agentId: string;
  status: AbStatus;
  createdAt: string;
  durationHours: number;
  arms: [AbArm, AbArm];
  winner?: AbArmKey;
  winnerConfidence: number;
  recommendation: AbRecommendation;
  rationale: string;
  primaryMetric: AbPrimaryMetric;
  series: Record<AbPrimaryMetric, AbMetricPoint[]>;
  sampleIds: string[];
  issueId?: string;
  sourceEvalBaselineId?: string;
  sourceEvalCompareId?: string;
  sourceDebuggerSessionId?: string;
};

export const AB_SAMPLES: AbSample[] = [];

export const AB_EXPERIMENTS: AbExperimentFixture[] = [];

function liveExperiments(): AbExperimentFixture[] {
  const live = catalogCompareExperiments();
  return live.length > 0 ? live : AB_EXPERIMENTS;
}

export function experimentById(
  id: string,
): AbExperimentFixture | undefined {
  return liveExperiments().find((e) => e.id === id);
}

export function sampleById(id: string): AbSample | undefined {
  return AB_SAMPLES.find((s) => s.id === id);
}

export function samplesForExperiment(experimentId: string): AbSample[] {
  const exp = experimentById(experimentId);
  if (!exp) return [];
  return exp.sampleIds
    .map((id) => sampleById(id))
    .filter((s): s is AbSample => Boolean(s));
}

export function experimentsForAgent(
  agentId: string | "all",
): AbExperimentFixture[] {
  if (agentId === "all") return liveExperiments();
  return liveExperiments().filter((e) => e.agentId === agentId);
}

export function defaultExperimentId(agentId: string | "all"): string {
  const list = experimentsForAgent(agentId);
  return list[0]?.id ?? liveExperiments()[0]?.id ?? "";
}

export function agentLabel(agentId: string): string {
  return agentById(agentId)?.name ?? agentId;
}

export function statusLabel(status: AbStatus): string {
  if (status === "winner_detected") return "winner";
  return status;
}

/** Arm role for operators: Current (control) vs Candidate (treatment). */
export function armRoleLabel(key: AbArmKey): string {
  return key === "control" ? "Current" : "Candidate";
}

export function verdictLabel(rec: AbRecommendation): string {
  if (rec === "ship") return "Ship";
  if (rec === "dont_ship") return "Don’t ship";
  if (rec === "ship_with_monitoring") return "Ship · monitor";
  return "Wait";
}

/** One-line ship answer including the candidate version name. */
export function verdictSentence(exp: AbExperimentFixture): string {
  const [, treatment] = exp.arms;
  const [control] = exp.arms;
  if (exp.recommendation === "ship") {
    return `Promote ${treatment.label} to 100%`;
  }
  if (exp.recommendation === "ship_with_monitoring") {
    return `Promote ${treatment.label} · watch cost`;
  }
  if (exp.recommendation === "dont_ship") {
    return `Keep ${control.label}`;
  }
  return `Need more ${treatment.label} traffic`;
}

export function confidenceLine(exp: AbExperimentFixture): string {
  const pct = Math.round(exp.winnerConfidence * 100);
  const [control, treatment] = exp.arms;
  const split = `${(control.weight * 100).toFixed(0)}/${(treatment.weight * 100).toFixed(0)}`;
  const age =
    exp.status === "active"
      ? `Live ${exp.createdAt.replace(" ago", "")}`
      : exp.createdAt;
  return `${age} · ${exp.durationHours}h · ${split} · ${pct}% conf`;
}

export function metricLabel(metric: AbPrimaryMetric): string {
  if (metric === "stumble") return "Fail rate";
  if (metric === "score") return "Score";
  if (metric === "cost") return "Cost / run";
  return "Latency p95";
}

export function metricShortLabel(metric: AbPrimaryMetric): string {
  if (metric === "stumble") return "Fail rate";
  if (metric === "score") return "Score";
  if (metric === "cost") return "Cost";
  return "p95";
}

export function layoutLabel(layout: AbLayout): string {
  if (layout === "overview") return "Decision";
  if (layout === "samples") return "Examples";
  return "Trend";
}

export function layoutSubtitle(layout: AbLayout): string {
  if (layout === "overview") return "Ship or don’t — arms + recommendation";
  if (layout === "samples") return "Paired live traces, graded vs current";
  return "Daily lift over the run";
}

export function formatMetricValue(
  metric: AbPrimaryMetric,
  value: number,
): string {
  if (metric === "stumble") return `${(value * 100).toFixed(1)}%`;
  if (metric === "score") return value.toFixed(2);
  if (metric === "cost") return `$${value.toFixed(3)}`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

/** Format a treatment−control delta for the verdict strip. */
export function formatDeltaDisplay(
  metric: AbPrimaryMetric,
  delta: number,
): string {
  if (metric === "stumble") {
    const pp = delta * 100;
    return `${pp >= 0 ? "+" : ""}${pp.toFixed(1)} pp`;
  }
  if (metric === "score") {
    return `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`;
  }
  if (metric === "cost") {
    const abs = Math.abs(delta);
    return `${delta >= 0 ? "+" : "−"}$${abs.toFixed(3)}`;
  }
  const abs = Math.abs(delta);
  const body =
    abs >= 1000 ? `${(abs / 1000).toFixed(1)}s` : `${Math.round(abs)}ms`;
  return `${delta >= 0 ? "+" : "−"}${body}`;
}

/** Signed Δ treatment − control. invertGood = lower is better. */
export function armDelta(
  exp: AbExperimentFixture,
  metric: AbPrimaryMetric,
): { delta: number; invertGood: boolean; better: "control" | "treatment" | "tie" } {
  const [control, treatment] = exp.arms;
  let delta = 0;
  let invertGood = false;
  if (metric === "stumble") {
    delta = treatment.stumbleRate - control.stumbleRate;
    invertGood = true;
  } else if (metric === "score") {
    delta = treatment.avgScore - control.avgScore;
  } else if (metric === "cost") {
    delta = treatment.costUsdPerTrace - control.costUsdPerTrace;
    invertGood = true;
  } else {
    delta = treatment.latencyP95Ms - control.latencyP95Ms;
    invertGood = true;
  }
  const eps = metric === "latency" ? 50 : 0.0005;
  let better: "control" | "treatment" | "tie" = "tie";
  if (Math.abs(delta) > eps) {
    const treatmentWins = invertGood ? delta < 0 : delta > 0;
    better = treatmentWins ? "treatment" : "control";
  }
  return { delta, invertGood, better };
}

export function betterArmLabel(
  better: "control" | "treatment" | "tie",
): string {
  if (better === "tie") return "tied";
  return better === "treatment" ? "Candidate" : "Current";
}

export function sampleGradeLabel(grade: AbSampleGrade): string {
  if (grade === "improve") return "Better";
  if (grade === "regress") return "Worse";
  if (grade === "tradeoff") return "Mixed";
  return "Same";
}

export function sortSamplesByGrade(samples: AbSample[]): AbSample[] {
  const rank = (g: AbSampleGrade) =>
    g === "regress" ? 0 : g === "tradeoff" ? 1 : g === "improve" ? 2 : 3;
  return [...samples].sort((a, b) => rank(a.grade) - rank(b.grade));
}

export function seedFromEvalsPair(
  baselineId: string | null,
  compareId: string | null,
): AbExperimentFixture | undefined {
  if (!baselineId || !compareId) return undefined;
  return liveExperiments().find(
    (e) =>
      e.sourceEvalBaselineId === baselineId &&
      e.sourceEvalCompareId === compareId,
  );
}

export function seedFromDebuggerSession(
  sessionId: string | null,
): AbExperimentFixture | undefined {
  if (!sessionId) return undefined;
  return liveExperiments().find((e) => e.sourceDebuggerSessionId === sessionId);
}

export function labCompareHref(params: {
  id?: string;
  agent?: string;
  layout?: AbLayout;
  metric?: AbPrimaryMetric;
  sample?: string;
  diff?: boolean;
  grade?: AbSampleGrade | "all";
  from?: "debugger" | "evals" | "issue";
  issueId?: string;
  baselineId?: string;
  compareId?: string;
}): string {
  const q = new URLSearchParams();
  if (params.id) q.set("id", params.id);
  if (params.agent) q.set("agent", params.agent);
  if (params.layout && params.layout !== "overview") q.set("layout", params.layout);
  if (params.metric && params.metric !== "stumble") q.set("metric", params.metric);
  if (params.sample) q.set("sample", params.sample);
  if (params.diff) q.set("diff", "1");
  if (params.grade && params.grade !== "all") q.set("grade", params.grade);
  if (params.from) q.set("from", params.from);
  if (params.issueId) q.set("issueId", params.issueId);
  if (params.baselineId) q.set("baselineId", params.baselineId);
  if (params.compareId) q.set("compareId", params.compareId);
  const qs = q.toString();
  return qs ? `/compare?${qs}` : "/compare";
}
