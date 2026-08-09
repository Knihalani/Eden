"use client";

import Link from "next/link";
import {
  agentLabel,
  matchesLine,
  type GuardrailPolicyFixture,
} from "@/lab/fixtures/guardrails";
import {
  GuardrailActionChip,
  GuardrailKindChip,
  GuardrailSeverityChip,
  GuardrailStatusChip,
} from "@/lab/guardrails/guardrails-chrome";
import { AgentLink, EmptyState } from "@/lab/lab-ui";

export function GuardrailsDetailView({
  policy,
}: {
  policy: GuardrailPolicyFixture | null;
}) {
  if (!policy) {
    return <EmptyState title="Select a policy" compact />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 space-y-2.5 border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <GuardrailKindChip kind={policy.kind} />
          <GuardrailStatusChip status={policy.status} />
          <GuardrailActionChip action={policy.action} />
          <GuardrailSeverityChip severity={policy.severity} />
        </div>
        <div className="min-w-0">
          <h2 className="type-title text-[var(--text)]">{policy.name}</h2>
          <p className="type-meta mt-0.5">
            <AgentLink
              agentId={policy.agentId}
              name={agentLabel(policy.agentId)}
            />
            <span className="text-[var(--text-faint)]"> · </span>
            {matchesLine(policy)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {policy.issueId ? (
            <Link
              href={`/issues?id=${policy.issueId}`}
              className="ds-btn ds-btn-sm"
            >
              Issue
            </Link>
          ) : null}
          {policy.traceIds?.[0] ? (
            <Link
              href={`/traces?id=${policy.traceIds[0]}${
                policy.agentId ? `&agent=${policy.agentId}` : ""
              }`}
              className="ds-btn ds-btn-sm"
            >
              Traces
            </Link>
          ) : null}
          {policy.agentId ? (
            <Link
              href={`/agents?id=${policy.agentId}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Agent
            </Link>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
        <section className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--accent-muted)] px-4 py-4">
          <h3 className="type-label">Rule</h3>
          <p className="type-ui text-[var(--text)]">
            {policy.ruleSummary ?? "—"}
          </p>
        </section>

        <section className="space-y-3">
          <h3 className="type-label">Enforcement</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Stat label="Action" value={policy.action} />
            <Stat label="Status" value={policy.status} />
            <Stat label="Severity" value={policy.severity ?? "—"} />
            <Stat
              label="Hits / 24h"
              value={
                policy.matchCount24h !== undefined
                  ? String(policy.matchCount24h)
                  : "—"
              }
            />
            <Stat label="Last hit" value={policy.lastHit ?? "—"} />
            <Stat label="Scope" value={agentLabel(policy.agentId)} />
          </dl>
        </section>

        {policy.traceIds && policy.traceIds.length > 0 ? (
          <section className="space-y-2">
            <h3 className="type-label">Sample traces</h3>
            <div className="flex flex-wrap gap-2">
              {policy.traceIds.map((id) => (
                <Link
                  key={id}
                  href={`/traces?id=${id}${
                    policy.agentId ? `&agent=${policy.agentId}` : ""
                  }`}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  {id}
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="type-meta text-[var(--text-faint)]">{label}</dt>
      <dd className="type-mono mt-0.5 tabular-nums !text-[0.75rem] text-[var(--text)]">
        {value}
      </dd>
    </div>
  );
}
