"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { improveApi, improvePlansApi, type ImproveQueueItem } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  isImprovementAgentDisabled,
  isRepoNotConnected,
  REPO_NOT_CONNECTED_MESSAGE,
} from "@/lib/improve-feature";
import { queueItemMatchesIssue } from "@/lib/improve-queue-issue";
import { useQueryTab } from "@/hooks/use-query-tab";
import {
  IMPROVE_TABS,
  type ImproveQueueColumnId,
} from "./improve-constants";
import { isN23PlanRef, planHref } from "./queue-helpers";

export function useImproveQueue() {
  const { currentOrg, authError } = useOrg();
  const { hasPermission } = usePermissions();
  const canManageKeys = hasPermission("settings:edit");
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const issueFilter = searchParams.get("issue")?.trim() || null;
  const orgId = currentOrg?.id ?? null;
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [tab, setTab] = useQueryTab("tab", IMPROVE_TABS, "queue");
  const [activeView, setActiveView] = useState<ImproveQueueColumnId>("needs_you");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const didAutoOpenPlan = useRef(false);

  const queueQuery = useOrgQuery(
    queryKeys.improve.queue(orgId),
    orgId,
    async () => {
      const res = await improveApi.queue(orgId!);
      return res.data ?? null;
    },
  );

  const featureGateQuery = useOrgQuery(
    queryKeys.improve.featureGate(orgId),
    orgId,
    async () => {
      try {
        await improvePlansApi.listPlans(orgId!, "limit=1");
        return { enabled: true as const };
      } catch (e) {
        if (isImprovementAgentDisabled(e)) {
          return { enabled: false as const };
        }
        return { enabled: true as const };
      }
    },
  );

  const items = queueQuery.data?.items ?? [];
  const refreshedAt = queueQuery.data?.refreshed_at ?? null;
  const loading = queueQuery.isLoading || featureGateQuery.isLoading;
  const featureDisabled = featureGateQuery.data?.enabled === false;

  const displayItems = useMemo(() => {
    if (!issueFilter) return items;
    return items.filter((item) => queueItemMatchesIssue(item, issueFilter));
  }, [items, issueFilter]);

  const load = () => queueQuery.refetch();

  useEffect(() => {
    if (!issueFilter || loading || didAutoOpenPlan.current) return;
    const planItems = displayItems.filter(isN23PlanRef);
    if (planItems.length !== 1) return;
    const href = planHref(planItems[0]);
    if (href?.startsWith("/improve/plans/")) {
      didAutoOpenPlan.current = true;
      router.replace(href);
    }
  }, [issueFilter, loading, displayItems, router]);

  const approveMutation = useOrgMutation(
    (item: ImproveQueueItem) => improveApi.approve(orgId!, item.ref),
    { invalidateKeys: [queryKeys.improve.queue(orgId)] },
  );

  const snoozeMutation = useOrgMutation(
    (item: ImproveQueueItem) => improveApi.snooze(orgId!, item.ref, 24),
    { invalidateKeys: [queryKeys.improve.queue(orgId)] },
  );

  const onApprove = async (item: ImproveQueueItem) => {
    if (!currentOrg) return;
    setBusyRef(item.ref);
    try {
      const res = await approveMutation.mutateAsync(item);
      const payload = res.data ?? {};
      const nested =
        payload.result && typeof payload.result === "object"
          ? (payload.result as { status?: string; pr_url?: string; message?: string })
          : null;
      const status =
        (typeof payload.status === "string" ? payload.status : null) ??
        nested?.status ??
        null;
      const prUrl = nested?.pr_url;
      const realSuccess =
        status === "pr_opened" ||
        status === "promoted" ||
        status === "promotion_queued";
      if (!realSuccess) {
        const reason =
          (typeof payload.message === "string" && payload.message) ||
          nested?.message ||
          (status ? `Approve returned ${status}` : "Approve did not succeed");
        toast.error(
          isRepoNotConnected(reason) ? REPO_NOT_CONNECTED_MESSAGE : reason,
        );
        return;
      }
      if (status === "pr_opened") {
        toast.success(prUrl ? "PR opened" : "Approved — PR opened");
      } else if (status === "promoted") {
        toast.success(nested?.message || payload.message || "Promoted");
      } else {
        toast.success(nested?.message || payload.message || "Promotion queued");
      }
    } catch (e) {
      if (isRepoNotConnected(e)) {
        toast.error(REPO_NOT_CONNECTED_MESSAGE);
      } else if (isImprovementAgentDisabled(e)) {
        toast.error(errorFromCaught(e, "Feature disabled — ask an admin"));
      } else {
        toast.error(errorFromCaught(e, "Approve failed"));
      }
    } finally {
      setBusyRef(null);
    }
  };

  const onSnooze = async (item: ImproveQueueItem) => {
    if (!currentOrg) return;
    setBusyRef(item.ref);
    try {
      await snoozeMutation.mutateAsync(item);
      toast.success("Snoozed 24h");
    } catch (e) {
      toast.error(errorFromCaught(e, "Snooze failed"));
    } finally {
      setBusyRef(null);
    }
  };

  const selectedItem =
    selectedRef != null
      ? (displayItems.find((i) => i.ref === selectedRef) ?? null)
      : null;

  return {
    currentOrg,
    authError,
    canManageKeys,
    issueFilter,
    tab,
    setTab,
    activeView,
    setActiveView,
    selectedRef,
    setSelectedRef,
    selectedItem,
    items,
    displayItems,
    refreshedAt,
    loading,
    featureDisabled,
    queueError: queueQuery.error,
    queueData: queueQuery.data,
    busyRef,
    load,
    onApprove,
    onSnooze,
  };
}

export type ImproveQueueController = ReturnType<typeof useImproveQueue>;
