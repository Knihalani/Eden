"use client";

import Link from "next/link";
import { useState } from "react";
import {
  agentForPlan,
  type ImprovePlanFixture,
} from "@/lab/fixtures/improve";
import { AgentLink, EmptyState } from "@/lab/lab-ui";
import {
  AutonomyTierChip,
  ImproveKindChip,
  ImproveStatusChip,
} from "@/lab/improve/improve-chrome";
import { RejectPlanDialog } from "@/components/improve/reject-plan-dialog";
import { MergePlanDialog } from "@/components/improve/merge-plan-dialog";
import { RevertPlanDialog } from "@/components/improve/revert-plan-dialog";

export function ImprovePlanView({
  plan,
  hasPlans = true,
  onStatus,
  onMerge,
  onRevert,
  onBack,
}: {
  plan: ImprovePlanFixture | null;
  /** False when the queue is empty — avoid “No plan selected” for zero work. */
  hasPlans?: boolean;
  onStatus: (
    id: string,
    status: ImprovePlanFixture["status"],
    reason?: string,
  ) => void | Promise<void>;
  onMerge?: (id: string) => void | Promise<void>;
  onRevert?: (id: string) => void | Promise<void>;
  onBack: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);
  if (!plan) {
    if (!hasPlans) {
      return (
        <EmptyState
          compact
          title="No plans yet"
          body="Improve plans appear after Agent Issues cluster production failures. Review Issues, then come back to Plan."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/issues" className="ds-btn ds-btn-primary ds-btn-sm">
                Open Issues
              </Link>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={onBack}
              >
                Queue
              </button>
            </div>
          }
        />
      );
    }
    return (
      <EmptyState
        compact
        title="No plan selected"
        body="Open Queue to pick an improve item, or wait for Agent Issues to produce a plan from production failures."
        action={
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={onBack}
          >
            Back to Queue
          </button>
        }
      />
    );
  }

  const agent = agentForPlan(plan);
  const primary = primaryHref(plan);
  // Synthesized deep-link plans (from Issues/Evals handoffs) have no
  // server row — Approve/Reject would 404. Only real plans mutate.
  const isSynthesized = plan.id.startsWith("plan_from_");
  const canDecide =
    !isSynthesized &&
    (plan.status === "needs_you" ||
      plan.status === "in_progress" ||
      plan.status === "verify");
  const canMerge =
    !isSynthesized &&
    plan.kind === "code_patch" &&
    plan.status === "verify" &&
    Boolean(plan.prUrl) &&
    Boolean(onMerge);
  const canRevert =
    !isSynthesized &&
    plan.kind === "code_patch" &&
    plan.status === "done" &&
    Boolean(plan.prUrl) &&
    !plan.parentPlanId &&
    Boolean(onRevert);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ImproveStatusChip status={plan.status} />
            <ImproveKindChip kind={plan.kind} />
            <AutonomyTierChip tierApplied={plan.autonomyTierRequired} />
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
          {canDecide ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm !text-[var(--error)]"
              title="Reject permanently via API"
              onClick={() => setRejecting(true)}
            >
              Reject
            </button>
          ) : null}
          {canRevert ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm !text-[var(--error)]"
              title="Draft and open a revert PR for this merged fix"
              onClick={() => setReverting(true)}
            >
              Revert
            </button>
          ) : null}
          {canMerge ? (
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              title="Merge the open PR on GitHub"
              onClick={() => setMerging(true)}
            >
              Merge PR
            </button>
          ) : null}
          {canDecide ? (
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              title="Approve via API — opens the fix path when GitHub is connected"
              onClick={() => void onStatus(plan.id, "done")}
            >
              Approve
            </button>
          ) : null}
          {isSynthesized ? (
            <span className="type-meta self-center">
              Draft from deep link — Eden has not generated a fix plan for
              this yet.
            </span>
          ) : null}
          {primary ? (
            // Ghost when Approve is also offered — two competing primary
            // CTAs read as a bug; the decision button keeps the accent.
            <Link
              href={primary.href}
              className={
                canDecide
                  ? "ds-btn ds-btn-ghost ds-btn-sm"
                  : "ds-btn ds-btn-primary ds-btn-sm"
              }
            >
              {primary.label}
            </Link>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-8 px-4 py-5 sm:px-6">
          <section>
            <p className="type-label mb-2">Why</p>
            <p className="type-body text-[var(--text-secondary)]">
              {plan.rca || "Root cause is attached to the linked issue."}
            </p>
            {plan.summary ? (
              <p className="type-meta mt-2">{plan.summary}</p>
            ) : null}
          </section>

          {plan.parentPlanId ? (
            <section>
              <p className="type-label mb-2">Regression follow-up</p>
              <p className="type-meta">
                Eden&apos;s post-merge guardian drafted this after the original
                fix regressed.{" "}
                <Link
                  href={`/improve?plan=${plan.parentPlanId}`}
                  className="underline"
                >
                  View the original plan
                </Link>
              </p>
            </section>
          ) : null}

          {plan.prUrl ? (
            <section>
              <p className="type-label mb-2">Pull request</p>
              <a
                href={plan.prUrl}
                target="_blank"
                rel="noreferrer"
                className="ds-btn ds-btn-ghost ds-btn-sm"
              >
                Open PR on GitHub
              </a>
            </section>
          ) : null}

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
                  href={`/playgrounds/${plan.playgroundId}`}
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
            {plan.diff ? (
              <DiffPane label="Unified diff" text={plan.diff} />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <DiffPane label="Before" text={plan.before} />
                <DiffPane label="After" text={plan.after} />
              </div>
            )}
          </section>
        </div>
      </div>

      {rejecting ? (
        <RejectPlanDialog
          planTitle={plan.title}
          busy={rejectBusy}
          onCancel={() => setRejecting(false)}
          onConfirm={async (reason) => {
            setRejectBusy(true);
            try {
              await onStatus(plan.id, "blocked", reason);
              setRejecting(false);
            } finally {
              setRejectBusy(false);
            }
          }}
        />
      ) : null}
      {merging && onMerge ? (
        <MergePlanDialog
          planTitle={plan.title}
          prUrl={plan.prUrl}
          busy={mergeBusy}
          onCancel={() => setMerging(false)}
          onConfirm={async () => {
            setMergeBusy(true);
            try {
              await onMerge(plan.id);
              setMerging(false);
            } finally {
              setMergeBusy(false);
            }
          }}
        />
      ) : null}
      {reverting && onRevert ? (
        <RevertPlanDialog
          planTitle={plan.title}
          prUrl={plan.prUrl}
          busy={revertBusy}
          onCancel={() => setReverting(false)}
          onConfirm={async () => {
            setRevertBusy(true);
            try {
              await onRevert(plan.id);
              setReverting(false);
            } finally {
              setRevertBusy(false);
            }
          }}
        />
      ) : null}
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
      href: `/playgrounds/${plan.playgroundId}`,
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
      href: `/playgrounds/${plan.playgroundId}`,
      label: "Try in Evals",
    };
  }
  return null;
}
