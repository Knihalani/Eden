"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { datasetsApi, type Dataset } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type AddToDatasetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  traceId?: string;
  spanId?: string;
  issueId?: string;
  evidenceTraceIds?: string[];
  agentId?: string;
  onSuccess?: (datasetId: string) => void;
  /** When true, navigate to `/evals?tab=datasets&datasetId=` after success. */
  navigateOnSuccess?: boolean;
};

function collectTraceIds(props: AddToDatasetDialogProps): string[] {
  const ids = new Set<string>();
  if (props.traceId) ids.add(props.traceId);
  for (const id of props.evidenceTraceIds ?? []) {
    if (id) ids.add(id);
  }
  return [...ids];
}

export function AddToDatasetDialog({
  open,
  onOpenChange,
  traceId,
  spanId: _spanId,
  issueId: _issueId,
  evidenceTraceIds,
  agentId: _agentId,
  onSuccess,
  navigateOnSuccess = true,
}: AddToDatasetDialogProps) {
  const t = useTranslations("evals.addToDataset");
  const router = useRouter();
  const toast = useToast();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const [selectedId, setSelectedId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [submitting, setSubmitting] = useState(false);

  const listQuery = useOrgQuery(
    queryKeys.datasets.list(orgId),
    orgId,
    () => datasetsApi.list(orgId!),
    { enabled: open && Boolean(orgId) },
  );

  const datasets: Dataset[] = useMemo(
    () => listQuery.data?.datasets ?? [],
    [listQuery.data],
  );

  const createMutation = useOrgMutation(
    (vars: { name: string; description?: string }) =>
      datasetsApi.create(orgId!, vars),
    { invalidateKeys: [queryKeys.datasets.all] },
  );

  const traceIds = useMemo(
    () => collectTraceIds({ open, onOpenChange, traceId, evidenceTraceIds }),
    [open, onOpenChange, traceId, evidenceTraceIds],
  );

  async function finish(datasetId: string) {
    toast.success(t("success"), t("successBody", { count: traceIds.length }));
    onSuccess?.(datasetId);
    onOpenChange(false);
    if (navigateOnSuccess) {
      router.push(
        `/evals?tab=datasets&datasetId=${encodeURIComponent(datasetId)}`,
      );
    }
  }

  async function handleSubmit() {
    if (!orgId || traceIds.length === 0) return;
    setSubmitting(true);
    try {
      let datasetId = selectedId;
      if (mode === "create") {
        const name = newName.trim();
        if (!name) {
          toast.error(t("nameRequired"));
          return;
        }
        const created = await createMutation.mutateAsync({
          name,
          description: t("createdFromEvidence"),
        });
        datasetId = created.id;
      }
      if (!datasetId) {
        toast.error(t("selectRequired"));
        return;
      }

      for (const id of traceIds) {
        await datasetsApi.promoteFromTrace(orgId, {
          trace_id: id,
          dataset_id: datasetId,
        });
      }
      await finish(datasetId);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("errorGeneric");
      toast.error(t("error"), message);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    traceIds.length > 0 &&
    Boolean(orgId) &&
    (mode === "create" ? newName.trim().length > 0 : Boolean(selectedId));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-to-dataset-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {traceIds.length > 1
              ? t("descriptionMany", { count: traceIds.length })
              : t("descriptionOne")}
          </DialogDescription>
        </DialogHeader>

        {traceIds.length === 0 ? (
          <p className="m-0 text-sm text-[var(--text-secondary)]" role="status">
            {t("noTraces")}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={mode === "existing" ? "secondary" : "ghost"}
                className="min-h-11"
                onClick={() => setMode("existing")}
                data-testid="add-to-dataset-mode-existing"
              >
                {t("existing")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "create" ? "secondary" : "ghost"}
                className="min-h-11"
                onClick={() => setMode("create")}
                data-testid="add-to-dataset-mode-create"
              >
                {t("createNew")}
              </Button>
            </div>

            {mode === "existing" ? (
              <div className="space-y-2">
                {listQuery.isLoading ? (
                  <p className="m-0 text-sm text-[var(--text-muted)]">
                    {t("loading")}
                  </p>
                ) : null}
                {listQuery.error ? (
                  <p className="m-0 text-sm text-[var(--error)]" role="alert">
                    {t("loadError")}
                  </p>
                ) : null}
                {datasets.length === 0 && !listQuery.isLoading ? (
                  <p className="m-0 text-sm text-[var(--text-secondary)]">
                    {t("emptyList")}
                  </p>
                ) : (
                  <select
                    className="h-11 w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm text-[var(--text-primary)]"
                    value={selectedId}
                    onChange={(e) => setSelectedId(e.target.value)}
                    aria-label={t("selectLabel")}
                    data-testid="add-to-dataset-select"
                  >
                    <option value="">{t("selectPlaceholder")}</option>
                    {datasets.map((ds) => (
                      <option key={ds.id} value={ds.id}>
                        {ds.name} ({ds.row_count})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : (
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("namePlaceholder")}
                aria-label={t("namePlaceholder")}
                className="h-11"
                data-testid="add-to-dataset-name"
              />
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={!canSubmit || submitting}
            loading={submitting}
            onClick={() => void handleSubmit()}
            data-testid="add-to-dataset-submit"
          >
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
