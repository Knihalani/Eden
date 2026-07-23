"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  agentLabel,
  matchesLine,
  policyById,
  testSamplesForAgent,
  type GuardrailPolicyFixture,
  type GuardrailTestSample,
} from "@/lab/fixtures/guardrails";
import {
  GuardrailActionChip,
  GuardrailKindChip,
  GuardrailSeverityChip,
  GuardrailStatusChip,
} from "@/lab/guardrails/guardrails-chrome";
import { AgentLink, AgentScopeFilter, EmptyState } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";

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
          <p className="type-ui text-[var(--text)]">{policy.ruleSummary}</p>
        </section>

        <section className="space-y-3">
          <h3 className="type-label">Enforcement</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Stat label="Action" value={policy.action} />
            <Stat label="Status" value={policy.status} />
            <Stat label="Severity" value={policy.severity} />
            <Stat label="Hits / 24h" value={String(policy.matchCount24h)} />
            <Stat label="Last hit" value={policy.lastHit} />
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

/** Dry-run panel — fixture sample in → policy hits out. No API. */
export function GuardrailsTestView({
  agentId,
  onAgentChange,
  counts,
}: {
  agentId: string;
  onAgentChange: (id: string) => void;
  counts?: Record<string, number>;
}) {
  const samples = useMemo(
    () => testSamplesForAgent(agentId),
    [agentId],
  );
  const [sampleId, setSampleId] = useState(
    () => samples[0]?.id ?? "",
  );

  useEffect(() => {
    if (samples.some((s) => s.id === sampleId)) return;
    setSampleId(samples[0]?.id ?? "");
  }, [samples, sampleId]);

  const sample: GuardrailTestSample | null =
    samples.find((s) => s.id === sampleId) ?? samples[0] ?? null;

  if (!sample) {
    return <EmptyState title="No test samples" compact />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="flex min-h-0 w-full flex-col border-b border-[var(--line)] lg:w-[18rem] lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
          <AgentScopeFilter
            value={agentId}
            onChange={onAgentChange}
            counts={counts}
          />
        </div>
        <p className="type-label border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
          Samples
        </p>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {samples.map((s) => {
            const active = s.id === sample.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSampleId(s.id)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 border-b border-[var(--line)] px-4 py-2.5 text-left transition-colors sm:px-5",
                    active
                      ? "bg-[var(--accent-muted)]"
                      : "hover:bg-[var(--bg-inset)]",
                  )}
                >
                  <span className="type-ui text-[var(--text)]">{s.label}</span>
                  <span className="type-meta">
                    {agentLabel(s.agentId)} · {s.hits.length} hit
                    {s.hits.length === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4 sm:p-5">
        <section className="space-y-2">
          <h2 className="type-label">Input</h2>
          <p className="type-mono rounded-[var(--radius)] bg-[var(--bg-inset)] px-3 py-3 !text-[0.75rem] text-[var(--text)]">
            {sample.input}
          </p>
        </section>

        <section className="mt-5 space-y-3">
          <h2 className="type-label">
            Hits
            <span className="ml-2 type-meta font-normal normal-case tracking-normal">
              {sample.hits.length === 0
                ? "none"
                : `${sample.hits.length} policy match${
                    sample.hits.length === 1 ? "" : "es"
                  }`}
            </span>
          </h2>

          {sample.hits.length === 0 ? (
            <p className="type-body text-[var(--text-secondary)]">
              No policies fired on this sample.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--line)] rounded-[var(--radius)] shadow-[0_0_0_1px_var(--line)]">
              {sample.hits.map((hit, i) => {
                const pol = policyById(hit.policyId);
                return (
                  <li key={`${hit.policyId}-${i}`} className="space-y-2 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {pol ? <GuardrailKindChip kind={pol.kind} /> : null}
                      <GuardrailActionChip action={hit.action} />
                      <span className="type-ui text-[var(--text)]">
                        {pol?.name ?? hit.policyId}
                      </span>
                    </div>
                    <p className="type-mono !text-[0.6875rem] text-[var(--text-secondary)]">
                      “{hit.excerpt}”
                    </p>
                    <p className="type-meta">{hit.note}</p>
                    {pol ? (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Link
                          href={`/guardrails?id=${pol.id}${
                            pol.agentId ? `&agent=${pol.agentId}` : ""
                          }`}
                          className="ds-btn ds-btn-ghost ds-btn-sm"
                        >
                          Policy
                        </Link>
                        {pol.issueId ? (
                          <Link
                            href={`/issues?id=${pol.issueId}`}
                            className="ds-btn ds-btn-ghost ds-btn-sm"
                          >
                            Issue
                          </Link>
                        ) : null}
                        {pol.traceIds?.[0] ? (
                          <Link
                            href={`/traces?id=${pol.traceIds[0]}`}
                            className="ds-btn ds-btn-ghost ds-btn-sm"
                          >
                            Trace
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
