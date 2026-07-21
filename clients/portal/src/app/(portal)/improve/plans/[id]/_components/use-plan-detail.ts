"use client";

import { useEffect, useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { improvePlansApi } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/components/ui/toast";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  isImprovementAgentDisabled,
  isRepoNotConnected,
  REPO_NOT_CONNECTED_MESSAGE,
} from "@/lib/improve-feature";

export function usePlanDetail(id: string) {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const orgId = currentOrg?.id ?? null;
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [reviewPane, setReviewPane] = useState<"diff" | "summary">("diff");
  const [editDiff, setEditDiff] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"reject" | "approve" | "snooze" | null>(
    null,
  );
  const [rejectReason, setRejectReason] = useState("");

  const planQuery = useOrgQuery(
    queryKeys.improve.plan(orgId, id),
    orgId,
    async () => {
      const data = await improvePlansApi.getPlan(orgId!, id);
      return data.data.plan;
    },
  );

  const plan = planQuery.data ?? null;
  const loading = planQuery.isLoading;
  const featureDisabled =
    !!planQuery.error && isImprovementAgentDisabled(planQuery.error);
  const error =
    planQuery.error && !featureDisabled
      ? errorFromCaught(planQuery.error, "Failed to load plan")
      : "";

  useEffect(() => {
    if (!plan || dirty) return;
    setEditDiff(plan.diff_unified ?? "");
    setEditTitle(plan.title ?? "");
    setEditSummary(plan.summary ?? "");
  }, [plan, dirty]);

  const invalidateKeys = [
    queryKeys.improve.plan(orgId, id),
    queryKeys.improve.all,
  ];

  const patchMutation = useOrgMutation(
    (body: { diff_unified?: string; title?: string; summary?: string }) =>
      improvePlansApi.patchPlan(orgId!, id, body),
    { invalidateKeys },
  );

  const approveMutation = useOrgMutation(
    () => improvePlansApi.approvePlan(orgId!, id),
    { invalidateKeys },
  );

  const rejectMutation = useOrgMutation(
    (reason: string) => improvePlansApi.rejectPlan(orgId!, id, reason),
    { invalidateKeys },
  );

  const snoozeMutation = useOrgMutation(
    (until: string) => improvePlansApi.snoozePlan(orgId!, id, until),
    { invalidateKeys },
  );

  const canAct =
    plan && ["draft", "pending_review", "approved"].includes(plan.status);

  async function handleSaveDraft() {
    if (!currentOrg || !plan) return;
    setBusyAction("save");
    try {
      await patchMutation.mutateAsync({
        diff_unified: editDiff,
        title: editTitle,
        summary: editSummary,
      });
      setDirty(false);
      toast.success("Draft saved");
    } catch (err) {
      toast.error(errorFromCaught(err, "Save failed"));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleApprove() {
    if (!currentOrg || !plan) return;
    setBusyAction("approve");
    try {
      if (dirty) {
        await patchMutation.mutateAsync({
          diff_unified: editDiff,
          title: editTitle,
          summary: editSummary,
        });
        setDirty(false);
      }
      const data = await approveMutation.mutateAsync();
      const status = data.data.status;
      const message = data.data.message;
      const prUrl = data.data.pr_url;
      const prNum = data.data.pr_number;
      const realSuccess =
        status === "pr_opened" ||
        status === "promoted" ||
        status === "promotion_queued";
      if (!realSuccess) {
        const failMsg =
          message ||
          (status ? `Approve returned ${status}` : "Approve did not succeed");
        toast.error(
          isRepoNotConnected(failMsg) ? REPO_NOT_CONNECTED_MESSAGE : failMsg,
        );
        setConfirmAction(null);
        await planQuery.refetch();
        return;
      }
      if (status === "pr_opened") {
        toast.success(prNum ? `PR #${prNum} opened` : "PR opened");
        setConfirmAction(null);
        await planQuery.refetch();
        if (prUrl) window.open(prUrl, "_blank", "noopener,noreferrer");
        return;
      }
      toast.success(message || "Plan approved");
      setConfirmAction(null);
      await planQuery.refetch();
    } catch (err) {
      if (isRepoNotConnected(err)) {
        toast.error(REPO_NOT_CONNECTED_MESSAGE);
      } else if (isImprovementAgentDisabled(err)) {
        toast.error(errorFromCaught(err, "Feature disabled — ask an admin"));
      } else {
        toast.error(errorFromCaught(err, "Approve failed"));
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function handleReject() {
    if (!currentOrg || !plan) return;
    setBusyAction("reject");
    try {
      await rejectMutation.mutateAsync(rejectReason);
      toast.success("Plan rejected");
      setConfirmAction(null);
      await planQuery.refetch();
    } catch (err) {
      toast.error(errorFromCaught(err, "Reject failed"));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSnooze() {
    if (!currentOrg || !plan) return;
    setBusyAction("snooze");
    try {
      const until = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      await snoozeMutation.mutateAsync(until);
      toast.success("Snoozed for 7 days");
      setConfirmAction(null);
      await planQuery.refetch();
    } catch (err) {
      toast.error(errorFromCaught(err, "Snooze failed"));
    } finally {
      setBusyAction(null);
    }
  }

  return {
    currentOrg,
    plan,
    planQuery,
    loading,
    featureDisabled,
    error,
    diffMode,
    setDiffMode,
    reviewPane,
    setReviewPane,
    editDiff,
    setEditDiff,
    editTitle,
    setEditTitle,
    editSummary,
    setEditSummary,
    dirty,
    setDirty,
    busyAction,
    confirmAction,
    setConfirmAction,
    rejectReason,
    setRejectReason,
    canAct,
    handleSaveDraft,
    handleApprove,
    handleReject,
    handleSnooze,
  };
}
