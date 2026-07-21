"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Clock,
  ExternalLink,
  GitPullRequest,
  RefreshCw,
  Save,
  Send,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { ImprovePlanStatusBadge } from "@/components/ui/status-badge";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PlanKindBadge } from "@/components/improve/plan-kind-badge";
import { ImproveFeatureDisabledState } from "@/components/improve/feature-disabled-state";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "./_components/plan-confirm-dialog";
import { PlanDetailBody } from "./_components/plan-detail-body";
import { usePlanDetail } from "./_components/use-plan-detail";

export default function ImprovementPlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const d = usePlanDetail(id);

  if (!d.currentOrg) {
    return (
      <NoOrgState
        feature="Improvement plan"
        description="Select an organization to review this plan."
      />
    );
  }

  if (d.loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="p-6 text-center py-12 text-[var(--text-muted)]"
      >
        <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
        Loading…
      </div>
    );
  }

  if (d.featureDisabled) {
    return (
      <div className="p-6" data-wave3-improve-plans="completed">
        <Button variant="ghost" onClick={() => router.push("/improve/plans")} className="mb-4">
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <ImproveFeatureDisabledState />
      </div>
    );
  }

  if (d.error || !d.plan) {
    return (
      <div className="p-6" data-wave3-improve-plans="completed">
        <Button variant="ghost" onClick={() => router.push("/improve/plans")} className="mb-4">
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <ErrorState
          title="Could not load plan"
          message={d.error || "Plan not found."}
          action={
            <Button onClick={() => void d.planQuery.refetch()} variant="outline" size="sm">
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const plan = d.plan;

  return (
    <PageContent size="wide">
      <div className="contents" data-wave3-improve-plans="completed">
      <Button variant="ghost" onClick={() => router.push("/improve/plans")} size="sm" className="min-h-11">
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to inbox
      </Button>

      <PageHeader
        eyebrow="Automate"
        title={plan.title || "Improvement plan"}
        subtitle={plan.summary ?? undefined}
        icon={GitPullRequest}
        actions={
          <div className="flex flex-wrap gap-2">
            {d.canAct && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => void d.handleSaveDraft()}
                  disabled={!d.dirty || d.busyAction === "save"}
                >
                  {d.busyAction === "save" ? (
                    <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  Save draft
                </Button>
                <Button
                  size="sm"
                  className="min-h-11"
                  onClick={() => d.setConfirmAction("approve")}
                  disabled={d.busyAction === "approve"}
                >
                  <Send className="h-4 w-4 mr-1" />
                  Approve & open PR
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => d.setConfirmAction("reject")}
                  disabled={d.busyAction === "reject"}
                >
                  <XCircle className="h-4 w-4 mr-1" />
                  Reject
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11"
                  onClick={() => d.setConfirmAction("snooze")}
                  disabled={d.busyAction === "snooze"}
                >
                  <Clock className="h-4 w-4 mr-1" />
                  Snooze 7d
                </Button>
              </>
            )}
            {plan.pr_url && (
              <Button asChild variant="outline" size="sm" className="min-h-11">
                <a href={plan.pr_url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  View PR #{plan.pr_number ?? ""}
                </a>
              </Button>
            )}
          </div>
        }
      />

      <div className="flex items-center gap-2 mb-6 flex-wrap -mt-4">
        <PlanKindBadge kind={plan.plan_kind} />
        <ImprovePlanStatusBadge status={plan.status} />
        {plan.diff_edited && (
          <Badge variant="outline" className="text-xs">
            Diff edited
          </Badge>
        )}
        {plan.source_ref && (
          <span className="text-xs text-[var(--text-muted)] font-mono">{plan.source_ref}</span>
        )}
      </div>

      <PlanDetailBody
        plan={plan}
        canAct={!!d.canAct}
        reviewPane={d.reviewPane}
        setReviewPane={d.setReviewPane}
        diffMode={d.diffMode}
        setDiffMode={d.setDiffMode}
        editDiff={d.editDiff}
        setEditDiff={d.setEditDiff}
        editTitle={d.editTitle}
        setEditTitle={d.setEditTitle}
        editSummary={d.editSummary}
        setEditSummary={d.setEditSummary}
        setDirty={d.setDirty}
      />

      <>
        {d.confirmAction === "approve" && (
          <ConfirmDialog
            title="Approve and open PR?"
            description="Approve always opens a GitHub PR immediately with the current diff. You can edit the diff above before confirming."
            confirmLabel="Approve & open PR"
            variant="primary"
            busy={d.busyAction === "approve"}
            onConfirm={() => void d.handleApprove()}
            onCancel={() => d.setConfirmAction(null)}
          />
        )}
        {d.confirmAction === "snooze" && (
          <ConfirmDialog
            title="Snooze this plan?"
            description="Hide this plan from the review inbox for 7 days. You can still open it from Plans."
            confirmLabel="Snooze 7 days"
            variant="primary"
            busy={d.busyAction === "snooze"}
            onConfirm={() => void d.handleSnooze()}
            onCancel={() => d.setConfirmAction(null)}
          />
        )}
        {d.confirmAction === "reject" && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open && d.busyAction !== "reject") d.setConfirmAction(null);
            }}
          >
            <DialogContent className="max-w-md" aria-describedby={undefined}>
              <DialogHeader>
                <DialogTitle>Reject this plan?</DialogTitle>
              </DialogHeader>
              <textarea
                value={d.rejectReason}
                onChange={(e) => d.setRejectReason(e.target.value)}
                placeholder="Optional reason (helps dedupe future sweeps)"
                aria-label="Rejection reason"
                className="w-full h-20 bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm"
              />
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => d.setConfirmAction(null)}
                  disabled={d.busyAction === "reject"}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void d.handleReject()}
                  disabled={d.busyAction === "reject"}
                  className="bg-[var(--error)] hover:bg-[var(--error)]/90 text-[var(--bg-primary)]"
                >
                  Reject
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </>
      </div>
    </PageContent>
  );
}
