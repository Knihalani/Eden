import { agentById, type AgentFixture } from "@/lab/fixtures/agents";
import {
  compareExperiments,
  datasetById,
  experimentById,
  type CompareGrade,
} from "@/lab/fixtures/evals";
import { issueById } from "@/lab/fixtures/issues";
import { catalogImprovePlans } from "@/lib/portal-catalog";

export type ImproveStatus =
  | "needs_you"
  | "in_progress"
  | "verify"
  | "done"
  | "blocked";

export type ImproveKind = "prompt_update" | "tool_policy" | "config";

export type ImprovePlanFixture = {
  id: string;
  title: string;
  summary: string;
  status: ImproveStatus;
  kind: ImproveKind;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  /** Eval handoff */
  baselineId?: string;
  compareId?: string;
  caseIds: string[];
  issueIds: string[];
  traceIds: string[];
  playgroundId?: string;
  /** Root-cause one-liner */
  rca: string;
  /** Before / after artifact (prompt or policy text) */
  before: string;
  after: string;
  /** Primary next action */
  primaryAction: "try_evals" | "recompare" | "open_trace" | "open_issue";
};

export const IMPROVE_PLANS: ImprovePlanFixture[] = [];

function livePlans(): ImprovePlanFixture[] {
  const live = catalogImprovePlans();
  return live.length > 0 ? live : IMPROVE_PLANS;
}

export function planById(id: string): ImprovePlanFixture | undefined {
  return livePlans().find((p) => p.id === id);
}

export function plansForAgent(agentId: string | "all"): ImprovePlanFixture[] {
  if (agentId === "all") return livePlans();
  return livePlans().filter((p) => p.agentId === agentId);
}

export function agentForPlan(
  plan: ImprovePlanFixture,
): AgentFixture | undefined {
  return agentById(plan.agentId);
}

export function statusLabel(status: ImproveStatus): string {
  if (status === "needs_you") return "needs you";
  if (status === "in_progress") return "in progress";
  if (status === "verify") return "verify";
  if (status === "done") return "done";
  return "blocked";
}

export function kindLabel(kind: ImproveKind): string {
  if (kind === "prompt_update") return "prompt";
  if (kind === "tool_policy") return "tools";
  return "config";
}

export function defaultPlanId(): string {
  const plans = livePlans();
  return (
    plans.find((p) => p.status === "needs_you")?.id ??
    plans[0]?.id ??
    ""
  );
}

/** Resolve or synthesize a plan from an Evals compare handoff. */
export function planFromCompare(
  baselineId: string | null,
  compareId: string | null,
  caseId: string | null,
  extras: ImprovePlanFixture[] = [],
): ImprovePlanFixture | null {
  const catalog = [...extras, ...livePlans()];
  if (compareId || baselineId) {
    const hit = catalog.find(
      (p) =>
        (compareId && p.compareId === compareId) ||
        (baselineId && p.baselineId === baselineId),
    );
    if (hit) {
      if (caseId && !hit.caseIds.includes(caseId)) {
        return { ...hit, caseIds: [caseId, ...hit.caseIds] };
      }
      return hit;
    }
  }

  if (!compareId && !baselineId) return null;

  const compare = compareId ? experimentById(compareId) : undefined;
  const baseline = baselineId ? experimentById(baselineId) : undefined;
  const { summary, rows } =
    baselineId && compareId
      ? compareExperiments(baselineId, compareId)
      : { summary: null, rows: [] };

  const focus =
    (caseId ? rows.find((r) => r.caseId === caseId) : undefined) ??
    rows.find((r) => r.grade === "regress" || r.grade === "tradeoff") ??
    rows[0];

  const grade: CompareGrade | null = summary?.overallGrade ?? null;
  const title =
    focus?.input?.slice(0, 48) ||
    compare?.name ||
    "Fix regressing eval";

  const ds = datasetById(compare?.datasetId ?? baseline?.datasetId ?? "");
  const agentId = ds?.agentId ?? "";

  return {
    id: `plan_from_${compareId ?? baselineId ?? "eval"}`,
    title: title.length >= 48 ? `${title}…` : title,
    summary:
      grade === "regress"
        ? "Newer run is worse — propose a fix and re-eval."
        : grade === "tradeoff"
          ? "Newer run is mixed — tighten the tradeoff."
          : "Act on this eval pair.",
    status: "needs_you",
    kind: "prompt_update",
    agentId,
    createdAt: "just now",
    updatedAt: "just now",
    baselineId: baselineId ?? undefined,
    compareId: compareId ?? undefined,
    caseIds: focus ? [focus.caseId] : caseId ? [caseId] : [],
    issueIds: [],
    traceIds: focus?.sourceTraceId ? [focus.sourceTraceId] : [],
    rca: focus
      ? `Case “${focus.input}” graded ${focus.grade} (Δ score ${focus.scoreDelta.toFixed(2)}).`
      : `Compare ${baseline?.name ?? baselineId} → ${compare?.name ?? compareId}.`,
    before: focus?.baseline?.output ?? "—",
    after: focus?.compare?.output
      ? `Target: keep quality of newer where good; restore older behavior where worse.\n\nNewer sample:\n${focus.compare.output}`
      : "Propose a prompt or policy change, then re-run on the same dataset.",
    primaryAction: "recompare",
  };
}

/** Resolve a plan from an Issues deep-link. */
export function planFromIssue(
  issueId: string,
  extras: ImprovePlanFixture[] = [],
): ImprovePlanFixture | null {
  const catalog = [...extras, ...livePlans()];
  const hit = catalog.find((p) => p.issueIds.includes(issueId));
  if (hit) return hit;
  const issue = issueById(issueId);
  if (!issue) return null;
  return {
    id: `plan_from_${issueId}`,
    title: issue.title,
    summary: issue.summary,
    status: "needs_you",
    kind: "prompt_update",
    agentId: issue.agentId,
    createdAt: "just now",
    updatedAt: "just now",
    caseIds: [],
    issueIds: [issueId],
    traceIds: issue.occurrenceTraceIds.slice(0, 2),
    rca: issue.impact,
    before: issue.errorSample,
    after: issue.suggestedFix,
    primaryAction: "open_issue",
  };
}

export function statusCounts(
  plans: ImprovePlanFixture[],
): Record<ImproveStatus | "all", number> {
  return {
    all: plans.length,
    needs_you: plans.filter((p) => p.status === "needs_you").length,
    in_progress: plans.filter((p) => p.status === "in_progress").length,
    verify: plans.filter((p) => p.status === "verify").length,
    done: plans.filter((p) => p.status === "done").length,
    blocked: plans.filter((p) => p.status === "blocked").length,
  };
}
