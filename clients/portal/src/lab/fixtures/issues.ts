import { TRACE_LIST, type TraceFixture } from "@/lab/fixtures/traces";
import { agentById, type AgentFixture } from "@/lab/fixtures/agents";
import { catalogIssues, catalogTraces } from "@/lib/portal-catalog";

/**
 * BUG-9: ``"ignored"`` is a valid resolve-status on the backend (see
 * ``_RESOLVE_STATUSES`` in agent_issues.py and ``AgentIssueResolveStatus``
 * in lib/api/resources.ts) reachable from the UI via the issue detail's
 * "Dismiss" action. The portal read-model (``_map_issue_status`` in
 * portal.py) always collapses ``"ignored"`` into ``"resolved"`` before an
 * ``IssueFixture`` reaches the client, so this value never actually shows
 * up as ``issue.status`` here — it exists on the type only so the
 * status-mutation call sites (``onStatus``/``setStatus``) can pass it
 * through without a cast.
 */
export type IssueStatus = "open" | "acknowledged" | "resolved" | "ignored";
export type IssueSeverity = "error" | "warn";

export type IssueFixture = {
  id: string;
  title: string;
  /** One-line impact for list rows */
  summary: string;
  body: string;
  severity: IssueSeverity;
  status: IssueStatus;
  agentId: string;
  fingerprint: string;
  /** Span / tool / detector that defines the group */
  detector: string;
  environment: string;
  occurrenceTraceIds: string[];
  firstSeen: string;
  lastSeen: string;
  /** Detector / signal hits across occurrences */
  signalCount: number;
  /** Owning Signals detector when known */
  relatedSignalId?: string;
  /** Representative error / log line */
  errorSample: string;
  /** What is blocked or degraded */
  impact: string;
  suggestedFix: string;
  /** Why Eden could not draft a fix PR (e.g. "repo_not_connected"). */
  patchBlockedReason?: string;
  patchBlockedMessage?: string;
  tags: string[];
};

/** Grouped failure patterns — what Home “needs attention” escalates into. */
export const ISSUE_LIST: IssueFixture[] = [];

function liveIssues(): IssueFixture[] {
  const live = catalogIssues();
  return live.length > 0 ? live : ISSUE_LIST;
}

function liveTraces(): TraceFixture[] {
  const live = catalogTraces();
  return live.length > 0 ? live : TRACE_LIST;
}

export function issueById(id: string): IssueFixture | undefined {
  return liveIssues().find((i) => i.id === id);
}

/** Map a run to its grouped issue (prefer open/in-progress over resolved). */
export function issueForTrace(traceId: string): IssueFixture | undefined {
  const matches = liveIssues().filter((i) =>
    i.occurrenceTraceIds.includes(traceId),
  );
  return (
    matches.find((i) => i.status !== "resolved") ?? matches[0] ?? undefined
  );
}

export function agentForIssue(issue: IssueFixture): AgentFixture | undefined {
  return agentById(issue.agentId);
}

export function occurrencesForIssue(issue: IssueFixture): TraceFixture[] {
  return issue.occurrenceTraceIds
    .map((id) => liveTraces().find((t) => t.id === id))
    .filter((t): t is TraceFixture => Boolean(t));
}

export function issuesSnapshot(issues: IssueFixture[] = liveIssues()) {
  const open = issues.filter((i) => i.status === "open");
  const acknowledged = issues.filter((i) => i.status === "acknowledged");
  const resolved = issues.filter((i) => i.status === "resolved");
  const errors = issues.filter((i) => i.severity === "error" && i.status !== "resolved");
  const warnings = issues.filter((i) => i.severity === "warn" && i.status !== "resolved");

  return {
    all: issues,
    open,
    acknowledged,
    resolved,
    errors,
    warnings,
    openCount: open.length,
    activeCount: open.length + acknowledged.length,
  };
}
