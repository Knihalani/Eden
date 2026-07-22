/**
 * Client-side EvidenceGate rules (surfaces/improve.md §13, artifacts.md §13).
 */

export type EvidenceRefs = {
  issueId?: string | null;
  experimentId?: string | null;
  alertId?: string | null;
  traceIds?: string[];
  evidence?: Record<string, unknown> | null;
};

export type EvidenceGateInput = {
  refs: EvidenceRefs;
  artifactSelected: boolean;
  artifactSealed?: boolean;
  gitConnected?: boolean;
  /** Audited Admin override reason present. */
  overrideReason?: string | null;
  forPr?: boolean;
};

export type EvidenceGateResult = {
  pass: boolean;
  status: "pass" | "fail" | "override" | "unknown";
  reasons: string[];
};

function hasLinkedEvidence(refs: EvidenceRefs): boolean {
  if (refs.issueId || refs.experimentId || refs.alertId) return true;
  if (refs.traceIds && refs.traceIds.length > 0) return true;
  const ev = refs.evidence;
  if (!ev || typeof ev !== "object") return false;
  const issue =
    ev.issue_id ?? ev.issueId ?? ev.issue ?? ev.alert_id ?? ev.alertId;
  const experiment = ev.experiment_id ?? ev.experimentId;
  const traces = ev.trace_ids ?? ev.traceIds ?? ev.traces;
  if (issue || experiment) return true;
  if (Array.isArray(traces) && traces.length > 0) return true;
  if (typeof traces === "string" && traces.trim()) return true;
  return Object.keys(ev).length > 0;
}

export function evaluateEvidenceGate(
  input: EvidenceGateInput,
): EvidenceGateResult {
  const reasons: string[] = [];

  if (!hasLinkedEvidence(input.refs)) {
    if (input.overrideReason?.trim()) {
      return {
        pass: true,
        status: "override",
        reasons: [`Override: ${input.overrideReason.trim()}`],
      };
    }
    reasons.push("Missing linked evidence (issue, experiment, or traces).");
  }

  if (!input.artifactSelected) {
    reasons.push("Select a sealed artifact version.");
  } else if (input.artifactSealed === false) {
    reasons.push("Artifact is still generating or draft — wait until sealed.");
  }

  if (input.forPr && input.gitConnected === false) {
    reasons.push("Connect git before opening a pull request.");
  }

  if (reasons.length === 0) {
    return { pass: true, status: "pass", reasons: [] };
  }

  if (input.overrideReason?.trim() && hasLinkedEvidence(input.refs) === false) {
    return {
      pass: true,
      status: "override",
      reasons: [`Override: ${input.overrideReason.trim()}`],
    };
  }

  return { pass: false, status: "fail", reasons };
}
