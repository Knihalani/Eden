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
import { formatSmartTime } from "@/lib/format";

/** OOM 9.4a: snooze duration options (hours). */
const SNOOZE_OPTIONS: { label: string; hours: number }[] = [
  { label: "1 day", hours: 24 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
];

export function ImprovePlanView({
  plan,
  hasPlans = true,
  onStatus,
  onMerge,
  onRevert,
  onSnooze,
  onIterate,
  onBack,
}: {
  plan: ImprovePlanFixture | null;
  /** False when the queue is empty — avoid "No plan selected" for zero work. */
  hasPlans?: boolean;
  onStatus: (
    id: string,
    status: ImprovePlanFixture["status"],
    reason?: string,
  ) => void | Promise<void>;
  onMerge?: (id: string) => void | Promise<void>;
  onRevert?: (id: string) => void | Promise<void>;
  /** OOM 9.4a: snooze the plan for the given number of hours. */
  onSnooze?: (id: string, hours: number) => void | Promise<void>;
  /** OOM 9.4b: request-changes → guardian follow-up iteration. */
  onIterate?: (id: string, feedback: string) => void | Promise<void>;
  onBack: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);
  const [iterating, setIterating] = useState(false);
  const [iterateFeedback, setIterateFeedback] = useState("");
  const [iterateBusy, setIterateBusy] = useState(false);
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
  /** OOM 9.4a: can snooze any non-synthesized, non-done/blocked plan. */
  const canSnooze =
    !isSynthesized &&
    Boolean(onSnooze) &&
    (plan.status === "needs_you" ||
      plan.status === "in_progress" ||
      plan.status === "verify");
  /** OOM 9.4b: can request changes when the PR is open (verify = pr_opened). */
  const canIterate =
    !isSynthesized &&
    Boolean(onIterate) &&
    plan.kind === "code_patch" &&
    (plan.status === "verify" || plan.status === "needs_you" || plan.status === "in_progress") &&
    Boolean(plan.prUrl || plan.status !== "verify");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ImproveStatusChip status={plan.status} />
            <ImproveKindChip kind={plan.kind} />
            <AutonomyTierChip tierApplied={plan.autonomyTierRequired} />
            {/* OOM 9.4a: snoozed_until chip — shows expiry when plan is snoozed. */}
            {plan.snoozedUntil ? (
              <span className="type-meta rounded border border-[var(--line)] px-1.5 py-0.5 text-[0.7rem] text-[var(--text-muted)]">
                Snoozed until {formatSmartTime(plan.snoozedUntil)}
              </span>
            ) : null}
          </div>
          <h2 className="type-ui mt-2 text-[var(--text)]">{plan.title}</h2>
          <p className="type-meta mt-1">
            <AgentLink
              agentId={agent?.id}
              name={agent?.name ?? plan.agentId}
            />
            <span className="type-sep mx-1.5">·</span>
            {formatSmartTime(plan.updatedAt)}
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
          {/* OOM 9.4a: snooze dropdown for non-done / non-blocked plans. */}
          {canSnooze ? (
            <div className="relative">
              <details className="group">
                <summary className="ds-btn ds-btn-ghost ds-btn-sm list-none cursor-pointer">
                  Snooze ▾
                </summary>
                <div className="absolute right-0 top-full z-10 mt-1 min-w-[8rem] rounded border border-[var(--line)] bg-[var(--surface)] py-1 shadow-md">
                  {SNOOZE_OPTIONS.map((opt) => (
                    <button
                      key={opt.hours}
                      type="button"
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--hover)]"
                      onClick={() => void onSnooze!(plan.id, opt.hours)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </details>
            </div>
          ) : null}
          {/* OOM 9.4b: request-changes / iterate on open-PR plans. */}
          {canIterate && !iterating ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              title="Request changes — guardian drafts a follow-up iteration"
              onClick={() => setIterating(true)}
            >
              Request changes
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
      {/* OOM 9.4b: inline feedback form for request-changes. */}
      {iterating ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--line)] bg-[var(--surface-raised)] px-4 py-3 sm:px-6">
          <p className="type-meta font-medium">
            Describe the changes you want the guardian to address:
          </p>
          <textarea
            className="ds-input min-h-[5rem] w-full resize-y text-sm"
            placeholder="e.g. The fix broke the timeout handling in retries — please address that edge case."
            value={iterateFeedback}
            onChange={(e) => setIterateFeedback(e.target.value)}
            autoFocus
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={iterateBusy || !iterateFeedback.trim()}
              onClick={async () => {
                setIterateBusy(true);
                try {
                  await onIterate!(plan.id, iterateFeedback.trim());
                  setIterating(false);
                  setIterateFeedback("");
                } finally {
                  setIterateBusy(false);
                }
              }}
            >
              {iterateBusy ? "Creating…" : "Create follow-up"}
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={iterateBusy}
              onClick={() => {
                setIterating(false);
                setIterateFeedback("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

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
