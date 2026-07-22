/**
 * C11 — citation kind/id → canonical href.
 * 1 click from any citation chip to its canonical surface.
 */

export type CitationKind =
  | "trace"
  | "span"
  | "session"
  | "issue"
  | "finding"
  | "agent"
  | "plan"
  | "artifact"
  | "debuggerSession"
  | "alert"
  | "experiment";

export interface CitationTarget {
  kind: CitationKind;
  id: string;
  /** Secondary id — e.g. spanId when kind=trace. */
  secondaryId?: string;
  /** Version for artifacts. */
  version?: string;
}

/**
 * Returns the canonical href for a given citation target.
 * All links are internal (relative) so next/router can handle them.
 */
export function citationHref(target: CitationTarget): string {
  const { kind, id, secondaryId, version } = target;

  switch (kind) {
    case "trace": {
      const params = new URLSearchParams({ traceId: id, mode: "transcript" });
      if (secondaryId) params.set("spanId", secondaryId);
      return `/traces?${params.toString()}`;
    }
    case "span": {
      const params = new URLSearchParams({ traceId: id, mode: "transcript" });
      if (secondaryId) params.set("spanId", secondaryId);
      return `/traces?${params.toString()}`;
    }
    case "session": {
      return `/traces?view=sessions&sessionId=${encodeURIComponent(id)}`;
    }
    case "issue": {
      return `/issues?issueId=${encodeURIComponent(id)}`;
    }
    case "finding": {
      // Findings live inside their parent Issue/Trace panel — deep-link via issueId if available.
      if (secondaryId) {
        return `/issues?issueId=${encodeURIComponent(secondaryId)}&findingId=${encodeURIComponent(id)}`;
      }
      return `/issues?findingId=${encodeURIComponent(id)}`;
    }
    case "agent": {
      return `/agents/${encodeURIComponent(id)}`;
    }
    case "plan": {
      return `/improve/plans/${encodeURIComponent(id)}`;
    }
    case "artifact": {
      const params = new URLSearchParams({ tab: "artifacts", artifactId: id });
      if (version) params.set("version", version);
      return `/improve?${params.toString()}`;
    }
    case "debuggerSession": {
      return `/debugger/${encodeURIComponent(id)}`;
    }
    case "alert": {
      return `/alerts?alertId=${encodeURIComponent(id)}`;
    }
    case "experiment": {
      return `/evals?tab=experiments&experimentId=${encodeURIComponent(id)}`;
    }
    default: {
      return "/";
    }
  }
}

/** Short display label for a citation. */
export function citationLabel(target: CitationTarget): string {
  const short = target.id.length > 12 ? `${target.id.slice(0, 8)}…` : target.id;
  switch (target.kind) {
    case "trace": return `Trace ${short}`;
    case "span": return `Span ${short}`;
    case "session": return `Session ${short}`;
    case "issue": return `Issue ${short}`;
    case "finding": return `Finding ${short}`;
    case "agent": return `Agent ${short}`;
    case "plan": return `Plan ${short}`;
    case "artifact": return target.version ? `Artifact ${short}@${target.version}` : `Artifact ${short}`;
    case "debuggerSession": return `Debug ${short}`;
    case "alert": return `Alert ${short}`;
    case "experiment": return `Experiment ${short}`;
    default: return short;
  }
}
