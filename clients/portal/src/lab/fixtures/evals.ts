import { agentById, type AgentFixture } from "@/lab/fixtures/agents";
import { issueById } from "@/lab/fixtures/issues";
import { traceById } from "@/lab/fixtures/traces";
import {
  catalogDatasets,
  catalogExperiments,
  catalogPlaygrounds,
} from "@/lib/portal-catalog";

export type DatasetSource = "traces" | "issues" | "manual" | "import";

export type DatasetFixture = {
  id: string;
  name: string;
  description: string;
  agentId: string | null;
  source: DatasetSource;
  version: string;
  updatedAt: string;
  caseIds: string[];
};

export type DatasetCaseFixture = {
  id: string;
  datasetId: string;
  input: string;
  expected?: string;
  tags: string[];
  sourceTraceId?: string;
  sourceSpanId?: string;
  sourceIssueId?: string;
};

export type PlaygroundVariant = {
  id: string;
  label: string;
  promptSnippet?: string;
  provider?: string;
};

export type PlaygroundFixture = {
  id: string;
  name: string;
  agentId?: string;
  datasetId?: string;
  prompt: string;
  model: string;
  dirty: boolean;
  variants: PlaygroundVariant[];
  lastRunId?: string;
};

export type ExperimentStatus = "completed" | "running" | "failed";

export type ExperimentFixture = {
  id: string;
  name: string;
  datasetId: string;
  playgroundId?: string;
  status: ExperimentStatus;
  createdAt: string;
  avgScores: Record<string, number>;
  latencyMs: number | null;
  costUsd: number | null;
  errorRate: number | null;
  suggestedBaselineId?: string;
  /** F51 honesty flags: eval scoring is a heuristic stub, not a real graded eval. */
  synthetic?: boolean;
  method?: string;
};

export type CompareGrade = "improve" | "regress" | "tradeoff" | "tie";

export type ExperimentCaseResult = {
  experimentId: string;
  caseId: string;
  output: string;
  scores: Record<string, number>;
  latencyMs: number;
  costUsd: number;
  error?: string;
};

export type CaseCompareRow = {
  caseId: string;
  input: string;
  expected?: string;
  baseline: ExperimentCaseResult | null;
  compare: ExperimentCaseResult | null;
  grade: CompareGrade;
  scoreDelta: number;
  latencyDelta: number;
  costDelta: number;
  sourceTraceId?: string;
};

export type CompareSummary = {
  baselineId: string;
  compareId: string;
  overallGrade: CompareGrade;
  scoreDelta: number;
  latencyDelta: number;
  costDelta: number;
  improveCount: number;
  regressCount: number;
  tradeoffCount: number;
  tieCount: number;
};

export const DATASET_CASES: DatasetCaseFixture[] = [];

export const DATASET_LIST: DatasetFixture[] = [];

export const PLAYGROUND_LIST: PlaygroundFixture[] = [];

export const EXPERIMENT_LIST: ExperimentFixture[] = [];

export const EXPERIMENT_RESULTS: ExperimentCaseResult[] = [];

/** Playground matrix cells: case × variant (canned). */
export type PlaygroundCell = {
  caseId: string;
  variantId: string;
  pass: boolean;
  output: string;
  score: number;
};

export const PLAYGROUND_MATRIX: PlaygroundCell[] = [];

function liveDatasets(): DatasetFixture[] {
  const live = catalogDatasets();
  return live.length > 0 ? live : DATASET_LIST;
}

function livePlaygrounds(): PlaygroundFixture[] {
  const live = catalogPlaygrounds();
  return live.length > 0 ? live : PLAYGROUND_LIST;
}

function liveExperiments(): ExperimentFixture[] {
  const live = catalogExperiments();
  return live.length > 0 ? live : EXPERIMENT_LIST;
}

export function datasetById(id: string): DatasetFixture | undefined {
  return liveDatasets().find((d) => d.id === id);
}

export function caseById(id: string): DatasetCaseFixture | undefined {
  return DATASET_CASES.find((c) => c.id === id);
}

export function casesForDataset(datasetId: string): DatasetCaseFixture[] {
  return DATASET_CASES.filter((c) => c.datasetId === datasetId);
}

export function playgroundById(id: string): PlaygroundFixture | undefined {
  return livePlaygrounds().find((p) => p.id === id);
}

export function experimentById(id: string): ExperimentFixture | undefined {
  return liveExperiments().find((e) => e.id === id);
}

export function experimentsForDataset(datasetId: string): ExperimentFixture[] {
  return liveExperiments().filter((e) => e.datasetId === datasetId);
}

export function resultsForExperiment(
  experimentId: string,
): ExperimentCaseResult[] {
  return EXPERIMENT_RESULTS.filter((r) => r.experimentId === experimentId);
}

export function agentForDataset(
  dataset: DatasetFixture,
): AgentFixture | undefined {
  if (!dataset.agentId) return undefined;
  return agentById(dataset.agentId);
}

export function matrixForPlayground(
  playground: PlaygroundFixture,
): PlaygroundCell[] {
  const caseIds = playground.datasetId
    ? casesForDataset(playground.datasetId).map((c) => c.id)
    : [];
  const variantIds = playground.variants.map((v) => v.id);
  return PLAYGROUND_MATRIX.filter(
    (c) => caseIds.includes(c.caseId) && variantIds.includes(c.variantId),
  );
}

function primaryScore(scores: Record<string, number>): number {
  const vals = Object.values(scores);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function gradeCase(
  baseline: ExperimentCaseResult | null,
  compare: ExperimentCaseResult | null,
): { grade: CompareGrade; scoreDelta: number; latencyDelta: number; costDelta: number } {
  if (!baseline || !compare) {
    return { grade: "tie", scoreDelta: 0, latencyDelta: 0, costDelta: 0 };
  }
  const scoreDelta = primaryScore(compare.scores) - primaryScore(baseline.scores);
  const latencyDelta = compare.latencyMs - baseline.latencyMs;
  const costDelta = compare.costUsd - baseline.costUsd;
  const qualityUp = scoreDelta > 0.05;
  const qualityDown = scoreDelta < -0.05;
  const costlier = costDelta > 0.01 || latencyDelta > 400;
  const cheaper = costDelta < -0.01 || latencyDelta < -400;

  if (qualityUp && !costlier) return { grade: "improve", scoreDelta, latencyDelta, costDelta };
  if (qualityDown && !cheaper) return { grade: "regress", scoreDelta, latencyDelta, costDelta };
  if (qualityUp && costlier) return { grade: "tradeoff", scoreDelta, latencyDelta, costDelta };
  if (qualityDown && cheaper) return { grade: "tradeoff", scoreDelta, latencyDelta, costDelta };
  if (baseline.error && !compare.error) {
    return { grade: "improve", scoreDelta, latencyDelta, costDelta };
  }
  if (!baseline.error && compare.error) {
    return { grade: "regress", scoreDelta, latencyDelta, costDelta };
  }
  return { grade: "tie", scoreDelta, latencyDelta, costDelta };
}

export function compareExperiments(
  baselineId: string,
  compareId: string,
  catalog?: {
    experiments?: ExperimentFixture[];
    results?: ExperimentCaseResult[];
    cases?: DatasetCaseFixture[];
  },
): { summary: CompareSummary; rows: CaseCompareRow[] } {
  const extras = catalog?.experiments ?? [];
  const extraResults = catalog?.results ?? [];
  const baseline = resolveExperiment(baselineId, extras);
  const compare = resolveExperiment(compareId, extras);
  const datasetId = compare?.datasetId ?? baseline?.datasetId;
  const fixtureCases = datasetId ? casesForDataset(datasetId) : [];
  const localCases = (catalog?.cases ?? []).filter(
    (c) => c.datasetId === datasetId,
  );
  const cases = [
    ...localCases,
    ...fixtureCases.filter((c) => !localCases.some((l) => l.id === c.id)),
  ];
  const baseResults = resolveResults(baselineId, extraResults);
  const cmpResults = resolveResults(compareId, extraResults);

  const rows: CaseCompareRow[] = cases.map((c) => {
    const b = baseResults.find((r) => r.caseId === c.id) ?? null;
    const m = cmpResults.find((r) => r.caseId === c.id) ?? null;
    const g = gradeCase(b, m);
    return {
      caseId: c.id,
      input: c.input,
      expected: c.expected,
      baseline: b,
      compare: m,
      grade: g.grade,
      scoreDelta: g.scoreDelta,
      latencyDelta: g.latencyDelta,
      costDelta: g.costDelta,
      sourceTraceId: c.sourceTraceId,
    };
  });

  const improveCount = rows.filter((r) => r.grade === "improve").length;
  const regressCount = rows.filter((r) => r.grade === "regress").length;
  const tradeoffCount = rows.filter((r) => r.grade === "tradeoff").length;
  const tieCount = rows.filter((r) => r.grade === "tie").length;

  let overallGrade: CompareGrade = "tie";
  if (improveCount > regressCount && improveCount >= tradeoffCount) {
    overallGrade = "improve";
  } else if (regressCount > improveCount) {
    overallGrade = "regress";
  } else if (tradeoffCount > 0 && tradeoffCount >= improveCount) {
    overallGrade = "tradeoff";
  } else if (improveCount > 0) {
    overallGrade = "improve";
  }

  const scoreDelta =
    (compare ? primaryScore(compare.avgScores) : 0) -
    (baseline ? primaryScore(baseline.avgScores) : 0);
  const latencyDelta = (compare?.latencyMs ?? 0) - (baseline?.latencyMs ?? 0);
  const costDelta = (compare?.costUsd ?? 0) - (baseline?.costUsd ?? 0);

  return {
    summary: {
      baselineId,
      compareId,
      overallGrade,
      scoreDelta,
      latencyDelta,
      costDelta,
      improveCount,
      regressCount,
      tradeoffCount,
      tieCount,
    },
    rows,
  };
}

export function defaultDatasetId(): string {
  return liveDatasets()[0]?.id ?? "";
}

/** Newest completed run for a dataset (list order = oldest → newest). */
export function latestCompletedForDataset(
  datasetId: string,
  extras: ExperimentFixture[] = [],
): ExperimentFixture | undefined {
  const runs = [...liveExperiments(), ...extras].filter(
    (e) => e.datasetId === datasetId && e.status === "completed",
  );
  return runs[runs.length - 1];
}

/** Older/Newer pair for a dataset — prefers newest completed. */
export function comparePairForDataset(
  datasetId: string,
  extras: ExperimentFixture[] = [],
): { baselineId: string; compareId: string } | null {
  const newest = latestCompletedForDataset(datasetId, extras);
  if (!newest) return null;
  const peers = [...liveExperiments(), ...extras].filter(
    (e) =>
      e.datasetId === datasetId &&
      e.status === "completed" &&
      e.id !== newest.id,
  );
  const baselineId =
    newest.suggestedBaselineId ??
    peers[peers.length - 1]?.id ??
    peers[0]?.id ??
    newest.id;
  return { baselineId, compareId: newest.id };
}

/** Pair anchored on a specific completed experiment as Newer. */
export function comparePairForExperiment(
  experimentId: string,
  extras: ExperimentFixture[] = [],
): { baselineId: string; compareId: string } | null {
  const exp =
    extras.find((e) => e.id === experimentId) ?? experimentById(experimentId);
  if (!exp || exp.status !== "completed") return null;
  const peers = [...liveExperiments(), ...extras].filter(
    (e) =>
      e.datasetId === exp.datasetId &&
      e.status === "completed" &&
      e.id !== exp.id,
  );
  const baselineId =
    exp.suggestedBaselineId ??
    peers[peers.length - 1]?.id ??
    peers[0]?.id ??
    exp.id;
  return { baselineId, compareId: exp.id };
}

/** Best default pair for Compare cold-open — primary dataset's newest run. */
export function defaultComparePair(
  extras: ExperimentFixture[] = [],
): { baselineId: string; compareId: string } {
  for (const ds of liveDatasets()) {
    const pair = comparePairForDataset(ds.id, extras);
    if (pair && pair.baselineId !== pair.compareId) return pair;
  }
  const completed = completedExperiments(extras);
  const last = completed[completed.length - 1];
  if (!last) return { baselineId: "", compareId: "" };
  const pair = comparePairForExperiment(last.id, extras);
  return pair ?? { baselineId: last.id, compareId: last.id };
}

export function completedExperiments(
  extras: ExperimentFixture[] = [],
): ExperimentFixture[] {
  return [...liveExperiments(), ...extras].filter((e) => e.status === "completed");
}

export function completedExperimentsForDataset(
  datasetId: string,
  extras: ExperimentFixture[] = [],
): ExperimentFixture[] {
  return completedExperiments(extras).filter((e) => e.datasetId === datasetId);
}

export function resolveExperiment(
  id: string,
  extras: ExperimentFixture[] = [],
): ExperimentFixture | undefined {
  return extras.find((e) => e.id === id) ?? experimentById(id);
}

export function resolveResults(
  experimentId: string,
  extras: ExperimentCaseResult[] = [],
): ExperimentCaseResult[] {
  const fromExtras = extras.filter((r) => r.experimentId === experimentId);
  if (fromExtras.length) return fromExtras;
  return resultsForExperiment(experimentId);
}

export function defaultPlaygroundId(): string {
  return livePlaygrounds()[0]?.id ?? "";
}

export function datasetsForAgent(agentId: string | "all"): DatasetFixture[] {
  if (agentId === "all") return liveDatasets();
  return liveDatasets().filter((d) => d.agentId === agentId);
}

export function playgroundsForAgent(agentId: string | "all"): PlaygroundFixture[] {
  if (agentId === "all") return livePlaygrounds();
  return livePlaygrounds().filter((p) => p.agentId === agentId);
}

export function experimentsForAgent(agentId: string | "all"): ExperimentFixture[] {
  if (agentId === "all") return liveExperiments();
  return liveExperiments().filter((e) => {
    const ds = datasetById(e.datasetId);
    return ds?.agentId === agentId;
  });
}

export function formatScore(n: number): string {
  return n.toFixed(2);
}

export function formatDelta(n: number, digits = 2): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}

/** Suggest a dataset when adding from a trace. */
export function datasetForTrace(traceId: string): DatasetFixture | undefined {
  const caseHit = DATASET_CASES.find((c) => c.sourceTraceId === traceId);
  if (caseHit) return datasetById(caseHit.datasetId);
  const trace = traceById(traceId);
  if (!trace) return undefined;
  return liveDatasets().find((d) => d.agentId === trace.agentId);
}

export function datasetForIssue(issueId: string): DatasetFixture | undefined {
  const caseHit = DATASET_CASES.find((c) => c.sourceIssueId === issueId);
  if (caseHit) return datasetById(caseHit.datasetId);
  const issue = issueById(issueId);
  if (!issue) return undefined;
  return liveDatasets().find((d) => d.agentId === issue.agentId);
}

export function caseForTrace(
  traceId: string,
  extras: DatasetCaseFixture[] = [],
): DatasetCaseFixture | undefined {
  return (
    extras.find((c) => c.sourceTraceId === traceId) ??
    DATASET_CASES.find((c) => c.sourceTraceId === traceId)
  );
}

export function caseForIssue(
  issueId: string,
  extras: DatasetCaseFixture[] = [],
): DatasetCaseFixture | undefined {
  return (
    extras.find((c) => c.sourceIssueId === issueId) ??
    DATASET_CASES.find((c) => c.sourceIssueId === issueId)
  );
}

/** Build a draft case from an Observe source id (trace or issue). */
export function draftCaseFromSource(
  sourceId: string,
  datasetId: string,
): DatasetCaseFixture | null {
  const trace = traceById(sourceId);
  if (trace) {
    const task = trace.steps.find((s) => s.kind === "task");
    return {
      id: `case_from_${sourceId}`,
      datasetId,
      input:
        task?.inputPreview ??
        task?.title ??
        trace.name,
      tags: ["from-trace"],
      sourceTraceId: sourceId,
    };
  }
  const issue = issueById(sourceId);
  if (issue) {
    return {
      id: `case_from_${sourceId}`,
      datasetId,
      input: issue.title,
      expected: issue.suggestedFix,
      tags: ["from-issue"],
      sourceIssueId: sourceId,
      sourceTraceId: issue.occurrenceTraceIds[0],
    };
  }
  return null;
}
