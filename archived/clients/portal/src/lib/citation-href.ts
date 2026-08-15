/**
 * C11 — citation kind/id → canonical href.
 * 1 click from any citation chip to its canonical surface.
 *
 * Query grammar matches live page readers (traces `id`/`span`/`session`,
 * issues `id`, evals `mode`/`id`/`baselineId`, improve `mode`/`id`).
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
  const { kind, id, secondaryId } = target;

  switch (kind) {
    case "trace": {
      const params = new URLSearchParams({ id });
      if (secondaryId) params.set("span", secondaryId);
      return `/traces?${params.toString()}`;
    }
    case "span": {
      // `id` is span id; `secondaryId` (when present) is the parent trace.
      if (secondaryId) {
        return `/traces?id=${encodeURIComponent(secondaryId)}&span=${encodeURIComponent(id)}`;
      }
      return `/traces?span=${encodeURIComponent(id)}`;
    }
    case "session": {
      return `/traces?view=sessions&session=${encodeURIComponent(id)}`;
    }
    case "issue": {
      return `/issues?id=${encodeURIComponent(id)}`;
    }
    case "finding": {
      if (secondaryId) {
        return `/issues?id=${encodeURIComponent(secondaryId)}`;
      }
      return "/issues";
    }
    case "agent": {
      return `/agents/${encodeURIComponent(id)}`;
    }
    case "plan": {
      return `/improve?mode=plan&id=${encodeURIComponent(id)}`;
    }
    case "artifact": {
      // Queue has no artifact selector yet.
      return "/improve?mode=queue";
    }
    case "debuggerSession": {
      return `/debugger/${encodeURIComponent(id)}`;
    }
    case "alert": {
      return `/signals?id=${encodeURIComponent(id)}`;
    }
    case "experiment": {
      return `/evals?mode=compare&baselineId=${encodeURIComponent(id)}`;
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
    case "alert": return `Detector ${short}`;
    case "experiment": return `Experiment ${short}`;
    default: return short;
  }
}
