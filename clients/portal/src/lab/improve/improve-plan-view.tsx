"use client";

import Link from "next/link";
import {
  agentForPlan,
  type ImprovePlanFixture,
} from "@/lab/fixtures/improve";
import { AgentLink, EmptyState } from "@/lab/lab-ui";
import {
  ImproveKindChip,
  ImproveStatusChip,
} from "@/lab/improve/improve-chrome";

export function ImprovePlanView({
  plan,
  onStatus,
  onBack,
}: {
  plan: ImprovePlanFixture | null;
  onStatus: (
    id: string,
    status: ImprovePlanFixture["status"],
  ) => void | Promise<void>;
  onBack: () => void;
}) {
  if (!plan) {
    return (
      <EmptyState
        compact
        title="No plan selected"
        action={
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onBack}
          >
            Queue
          </button>
        }
      />
    );
  }

  const agent = agentForPlan(plan);
  const primary = primaryHref(plan);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ImproveStatusChip status={plan.status} />
            <ImproveKindChip kind={plan.kind} />
          </div>
          <h2 className="type-ui mt-2 text-[var(--text)]">{plan.title}</h2>
          <p className="type-meta mt-1">
            <AgentLink
              agentId={agent?.id}
              name={agent?.name ?? plan.agentId}
            />
            <span className="type-sep mx-1.5">·</span>
            {plan.updatedAt}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onBack}
          >
            Queue
          </button>
          {plan.status === "needs_you" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => void onStatus(plan.id, "in_progress")}
            >
              Start
            </button>
          ) : null}
          {plan.status === "in_progress" || plan.status === "needs_you" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => void onStatus(plan.id, "verify")}
            >
              Mark verify
            </button>
          ) : null}
          {plan.status === "needs_you" ||
          plan.status === "in_progress" ||
          plan.status === "verify" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm !text-[var(--error)]"
              onClick={() => void onStatus(plan.id, "blocked")}
            >
              Reject
            </button>
          ) : null}
          {plan.status === "verify" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => void onStatus(plan.id, "done")}
            >
              Approve
            </button>
          ) : null}
          {primary ? (
            <Link href={primary.href} className="ds-btn ds-btn-primary ds-btn-sm">
              {primary.label}
            </Link>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-8 px-4 py-5 sm:px-6">
          <section>
            <p className="type-label mb-2">Why</p>
            <p className="type-body text-[var(--text-secondary)]">{plan.rca}</p>
            <p className="type-meta mt-2">{plan.summary}</p>
          </section>

          <section>
            <p className="type-label mb-2">Evidence</p>
            <div className="flex flex-wrap gap-2">
              {plan.baselineId && plan.compareId ? (
                <Link
                  href={`/evals?baselineId=${plan.baselineId}&compareId=${plan.compareId}${
                    plan.caseIds[0] ? `&case=${plan.caseIds[0]}&layout=list` : ""
                  }`}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Evals compare
                </Link>
              ) : null}
              {plan.playgroundId ? (
                <Link
                  href={`/evals?mode=playground&id=${plan.playgroundId}`}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Try draft
                </Link>
              ) : null}
              {plan.traceIds.map((id) => (
                <Link
                  key={id}
                  href={`/traces?id=${id}`}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Trace {id}
                </Link>
              ))}
              {plan.issueIds.map((id) => (
                <Link
                  key={id}
                  href={`/issues?id=${id}`}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Issue {id}
                </Link>
              ))}
              {plan.caseIds.length > 0 ? (
                <span className="type-meta self-center">
                  {plan.caseIds.length} case
                  {plan.caseIds.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          </section>

          <section>
            <p className="type-label mb-3">Change</p>
            <div className="grid gap-4 lg:grid-cols-2">
              <DiffPane label="Before" text={plan.before} />
              <DiffPane label="After" text={plan.after} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function DiffPane({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  return (
    <div className="rounded-[var(--radius)] bg-[var(--bg-inset)] px-4 py-3">
      <p className="type-label mb-2">{label}</p>
      <pre className="type-mono whitespace-pre-wrap !text-[0.75rem] !leading-relaxed !text-[var(--text-secondary)]">
        {text}
      </pre>
    </div>
  );
}

function primaryHref(
  plan: ImprovePlanFixture,
): { href: string; label: string } | null {
  if (plan.primaryAction === "try_evals" && plan.playgroundId) {
    return {
      href: `/evals?mode=playground&id=${plan.playgroundId}`,
      label: "Try in Evals",
    };
  }
  if (
    plan.primaryAction === "recompare" &&
    plan.baselineId &&
    plan.compareId
  ) {
    return {
      href: `/evals?baselineId=${plan.baselineId}&compareId=${plan.compareId}${
        plan.caseIds[0] ? `&case=${plan.caseIds[0]}&layout=list` : ""
      }`,
      label: "Re-compare",
    };
  }
  if (plan.primaryAction === "open_trace" && plan.traceIds[0]) {
    return {
      href: `/traces?id=${plan.traceIds[0]}`,
      label: "Open trace",
    };
  }
  if (plan.primaryAction === "open_issue" && plan.issueIds[0]) {
    return {
      href: `/issues?id=${plan.issueIds[0]}`,
      label: "Open issue",
    };
  }
  if (plan.baselineId && plan.compareId) {
    return {
      href: `/evals?baselineId=${plan.baselineId}&compareId=${plan.compareId}`,
      label: "Open Evals",
    };
  }
  if (plan.playgroundId) {
    return {
      href: `/evals?mode=playground&id=${plan.playgroundId}`,
      label: "Try in Evals",
    };
  }
  return null;
}
