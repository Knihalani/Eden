"use client";

/**
 * RcaCausalChainPanel — FEAT-65: within-trace + cross-agent causal-chain
 * navigation for agent delegation failures.
 *
 * Consumes the real ``GET /orgs/{orgId}/intelligence/rca/{traceId}/chain``
 * endpoint (``eden.api.routes.intelligence_rca.rca_chain``) via ``rcaChainApi``.
 * Renders two things a debugging engineer needs to walk from a failing
 * child-agent span back to the root cause:
 *
 *   1. ``delegation_chain`` — the cross-agent hops (``a2a_links``) from this
 *      trace's root agent up to whichever ancestor agent's delegating span
 *      is the practical origin of the failure (``cross_agent_root_cause``).
 *   2. ``causal_chain`` — the within-trace, temporally-ordered span list,
 *      each node flagged ``implicated`` when it errored, with per-node
 *      delegation metadata surfaced when the SDK tagged it.
 *
 * Every hop / span is deep-linkable via ``onSelectTrace`` (switch the page
 * to another trace) so the chain is actually walkable, not just displayed.
 */

import { AlertTriangle, ArrowUpRight, GitBranch } from "lucide-react";
import { StatusChip } from "@/components/ds/primitives";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { useOrgQuery } from "@/hooks/use-api-query";
import { EmptyState } from "@/lab/lab-ui";
import { rcaChainApi, type RcaChainNode, type RcaDelegationHop } from "@/lib/api/resources";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

export function RcaCausalChainPanel({
  orgId,
  traceId,
  onSelectTrace,
}: {
  orgId: string | null | undefined;
  traceId: string | null | undefined;
  /**
   * Deep-link into another trace — wire this to the page's own
   * trace-selection callback (e.g. ``selectTrace``) so clicking a
   * delegation hop actually navigates there.
   */
  onSelectTrace?: (traceId: string, spanId?: string | null) => void;
}) {
  const query = useOrgQuery(
    queryKeys.rcaChain.detail(orgId, traceId),
    orgId,
    async ({ signal }) => rcaChainApi.chain(orgId as string, traceId as string, signal),
    { enabled: Boolean(orgId && traceId), staleTime: 15_000 },
  );

  if (!traceId) {
    return <EmptyState title="No run selected" compact />;
  }
  if (query.isError) {
    return (
      <div className="p-6">
        <QueryErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  if (query.isLoading) {
    return <QueryLoadingPanel label="Walking the causal chain…" />;
  }

  const envelope = query.data;
  const data = envelope?.data;
  if (!envelope || envelope.status !== "ok" || !data) {
    return (
      <EmptyState
        title="No causal chain available"
        body="This run has no telemetry events to build a root-cause chain from."
        compact
        action={
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        }
      />
    );
  }

  const delegationChain = data.delegation_chain ?? [];
  const crossAgentRootCause = data.cross_agent_root_cause;
  const crossesAgents =
    crossAgentRootCause && crossAgentRootCause.trace_id !== data.trace_id;

  return (
    <div className="min-h-0 h-full overflow-y-auto p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-label text-[var(--text-muted)]">Failure category</span>
        <StatusChip tone={data.category ? "fail" : "neutral"}>
          {data.category ?? "unknown"}
        </StatusChip>
        {typeof data.confidence === "number" ? (
          <span className="type-meta">
            confidence {(data.confidence * 100).toFixed(0)}%
          </span>
        ) : null}
        <span className="type-meta">· {data.span_count} spans</span>
      </div>

      {data.signals.length > 0 ? (
        <ul className="type-meta mt-2 list-inside list-disc space-y-0.5">
          {data.signals.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}

      {crossAgentRootCause ? (
        <div
          className={cn(
            "mt-4 rounded-[var(--radius)] border px-3 py-2.5",
            crossesAgents
              ? "border-[color-mix(in_srgb,var(--error)_35%,var(--line))] bg-[var(--bg-inset)]"
              : "border-[var(--line)] bg-[var(--bg-inset)]",
          )}
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--error)]" aria-hidden />
            <span className="type-ui text-[var(--text)]">
              {crossesAgents ? "Cross-agent root cause" : "Root cause (this trace)"}
            </span>
          </div>
          <p className="type-meta mt-1">
            {crossesAgents
              ? "The failure propagated up the delegation chain — the practical origin is a parent agent's delegating span, not this trace."
              : "No ancestor delegation hop also failed, so the local trace's own root-cause span is authoritative."}
          </p>
          {crossAgentRootCause.span_id ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm mt-2 gap-1"
              onClick={() =>
                onSelectTrace?.(crossAgentRootCause.trace_id, crossAgentRootCause.span_id)
              }
              disabled={!onSelectTrace || !crossesAgents}
            >
              {crossesAgents ? (
                <>
                  Jump to origin span
                  <ArrowUpRight className="h-3 w-3" aria-hidden />
                </>
              ) : (
                <>span {crossAgentRootCause.span_id}</>
              )}
            </button>
          ) : null}
        </div>
      ) : null}

      {delegationChain.length > 0 ? (
        <section className="mt-5">
          <h3 className="type-label flex items-center gap-1.5 text-[var(--text-muted)]">
            <GitBranch className="h-3.5 w-3.5" aria-hidden />
            Delegation chain ({delegationChain.length}{" "}
            {delegationChain.length === 1 ? "hop" : "hops"} up from this trace)
          </h3>
          <ol className="mt-2 space-y-2">
            {delegationChain.map((hop, i) => (
              <DelegationHopRow
                key={`${hop.trace_id}-${hop.span_id ?? i}`}
                hop={hop}
                depth={i + 1}
                onSelectTrace={onSelectTrace}
              />
            ))}
          </ol>
        </section>
      ) : (
        <p className="type-meta mt-5 text-[var(--text-muted)]">
          No cross-agent delegation link found for this trace — the causal chain
          below stays within this trace.
        </p>
      )}

      <section className="mt-5">
        <h3 className="type-label text-[var(--text-muted)]">
          Causal chain ({data.implicated_span_ids.length} implicated of{" "}
          {data.span_count})
        </h3>
        <ol className="mt-2 space-y-1.5">
          {data.causal_chain.map((node) => (
            <CausalChainRow
              key={`${node.step}-${node.span_id ?? "?"}`}
              node={node}
              isRootCause={node.span_id === data.root_cause_span_id}
            />
          ))}
        </ol>
      </section>
    </div>
  );
}

function DelegationHopRow({
  hop,
  depth,
  onSelectTrace,
}: {
  hop: RcaDelegationHop;
  depth: number;
  onSelectTrace?: (traceId: string, spanId?: string | null) => void;
}) {
  return (
    <li className="rounded-[var(--radius)] border border-[var(--line)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-meta text-[var(--text-muted)]">#{depth}</span>
        <StatusChip tone={hop.delegating_span_failed ? "fail" : "ok"}>
          {hop.delegating_span_failed ? "delegating span failed" : "delegating span ok"}
        </StatusChip>
        {hop.response_status ? (
          <span className="type-meta">a2a status: {hop.response_status}</span>
        ) : null}
        {hop.error_kind ? (
          <span className="type-meta text-[var(--error)]">{hop.error_kind}</span>
        ) : null}
      </div>
      <p className="type-meta mt-1">
        {hop.parent_agent_id ?? "unknown agent"} → {hop.child_agent_id ?? "unknown agent"}
        {hop.invocation_type ? ` · ${hop.invocation_type}` : ""}
      </p>
      <button
        type="button"
        className="ds-btn ds-btn-ghost ds-btn-sm mt-1.5 gap-1"
        onClick={() => onSelectTrace?.(hop.trace_id, hop.span_id)}
        disabled={!onSelectTrace}
      >
        Open parent trace
        <ArrowUpRight className="h-3 w-3" aria-hidden />
      </button>
    </li>
  );
}

function CausalChainRow({
  node,
  isRootCause,
}: {
  node: RcaChainNode;
  isRootCause: boolean;
}) {
  return (
    <li
      className={cn(
        "rounded-[var(--radius)] border px-3 py-1.5",
        node.implicated
          ? "border-[color-mix(in_srgb,var(--error)_35%,var(--line))] bg-[var(--bg-inset)]"
          : "border-[var(--line)]",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="type-meta text-[var(--text-muted)]">step {node.step}</span>
        <span className="type-ui truncate text-[var(--text)]">
          {node.name ?? node.event_type ?? node.span_id ?? "span"}
        </span>
        {node.implicated ? (
          <StatusChip tone="fail">{node.error_type ?? "error"}</StatusChip>
        ) : null}
        {isRootCause ? <StatusChip tone="fail">root cause</StatusChip> : null}
        {node.delegation ? (
          <StatusChip tone="neutral">delegation</StatusChip>
        ) : null}
      </div>
      {node.delegation ? (
        <p className="type-meta mt-0.5 text-[var(--text-muted)]">
          {node.delegation.parent_agent_id
            ? `invoked by ${node.delegation.parent_agent_id}`
            : "carries A2A delegation metadata"}
          {node.delegation.parent_agent_span_id
            ? ` (parent span ${node.delegation.parent_agent_span_id})`
            : ""}
        </p>
      ) : null}
    </li>
  );
}
