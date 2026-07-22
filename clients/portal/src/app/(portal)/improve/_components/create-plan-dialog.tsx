"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { improveRunsApi } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import {
  isImprovementAgentDisabled,
  IMPROVE_FEATURE_DISABLED_DESCRIPTION,
} from "@/lib/improve-feature";
import { queryKeys } from "@/lib/query-keys";
import { useImproveUrlState } from "../_hooks/use-improve-url-state";

export type CreatePlanDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreatePlanDialog({ open, onOpenChange }: CreatePlanDialogProps) {
  const t = useTranslations("improve");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { state, setState } = useImproveUrlState();

  const [issueId, setIssueId] = useState(state.issueId ?? "");
  const [traceId, setTraceId] = useState(state.traceId ?? "");
  const [experimentId, setExperimentId] = useState(state.experimentId ?? "");
  const [agentId, setAgentId] = useState(state.agentId ?? "");
  const [manualAck, setManualAck] = useState(false);

  const hasEvidence = Boolean(
    issueId.trim() || traceId.trim() || experimentId.trim(),
  );

  const createMutation = useOrgMutation(
    () =>
      improveRunsApi.triggerRun(orgId!, {
        agent_id: agentId.trim() || undefined,
        issue_id: issueId.trim() || undefined,
      }),
    {
      invalidateKeys: [
        queryKeys.improve.plans(orgId),
        queryKeys.improve.runs(orgId),
        queryKeys.improve.queue(orgId),
      ],
      onSuccess: (res) => {
        const planIds = res.data?.plan_ids ?? [];
        const first = planIds[0];
        onOpenChange(false);
        if (first) {
          setState({ tab: "plans", planId: first });
        } else if (res.data?.run_id) {
          setState({ tab: "history" });
        } else {
          toast.error(res.data?.error || res.data?.reason || t("create.noPlan"));
        }
      },
      onError: (err) => {
        if (isImprovementAgentDisabled(err)) {
          toast.error(IMPROVE_FEATURE_DISABLED_DESCRIPTION);
          return;
        }
        toast.error(err.message || t("create.failed"));
      },
    },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="create-plan-dialog">
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">
            {t("create.body")}
          </p>
          <Input
            value={issueId}
            onChange={(e) => setIssueId(e.target.value)}
            placeholder={t("create.issuePlaceholder")}
            aria-label={t("create.issuePlaceholder")}
          />
          <Input
            value={traceId}
            onChange={(e) => setTraceId(e.target.value)}
            placeholder={t("create.tracePlaceholder")}
            aria-label={t("create.tracePlaceholder")}
          />
          <Input
            value={experimentId}
            onChange={(e) => setExperimentId(e.target.value)}
            placeholder={t("create.experimentPlaceholder")}
            aria-label={t("create.experimentPlaceholder")}
          />
          <Input
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder={t("create.agentPlaceholder")}
            aria-label={t("create.agentPlaceholder")}
          />
          {!hasEvidence ? (
            <div className="space-y-2 rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm">
              <p>{t("create.manualWarning")}</p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={manualAck}
                  onChange={(e) => setManualAck(e.target.checked)}
                />
                {t("create.manualAck")}
              </label>
            </div>
          ) : null}
          {traceId || experimentId ? (
            <Textarea
              readOnly
              value={[
                traceId ? `traceId=${traceId}` : null,
                experimentId ? `experimentId=${experimentId}` : null,
              ]
                .filter(Boolean)
                .join("\n")}
              className="font-mono text-xs"
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={
              !orgId ||
              createMutation.isPending ||
              (!hasEvidence && !manualAck)
            }
            loading={createMutation.isPending}
            onClick={() => void createMutation.mutateAsync()}
            data-testid="create-plan-submit"
          >
            {t("create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
