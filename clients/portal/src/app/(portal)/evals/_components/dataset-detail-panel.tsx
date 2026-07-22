"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  datasetsApi,
  offlineExperimentsApi,
  type Dataset,
  type DatasetRow,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { DatasetCaseRow } from "@/components/evals/dataset-case-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatRelativeTime } from "@/lib/format";
import { useEvalsUrlState } from "../_hooks/use-evals-url-state";
import type { DatasetListRow } from "../_hooks/use-datasets-tab";

export type DatasetDetailPanelProps = {
  datasetId: string;
  listRow?: DatasetListRow | null;
  open: boolean;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  canMutate: boolean;
  mobileDrawer?: boolean;
  /** Full-page mode — skip DetailPanelShell chrome. */
  fullPage?: boolean;
};

function caseInput(row: DatasetRow): string {
  return String(
    row.input ??
      row.values?.input ??
      row.values?.prompt ??
      Object.values(row.values ?? {})[0] ??
      "",
  );
}

function caseExpected(row: DatasetRow): string | undefined {
  const v = row.expected_output ?? row.values?.expected_output ?? row.values?.expected;
  return v != null && String(v).trim() ? String(v) : undefined;
}

function caseTags(row: DatasetRow): string[] {
  const raw = row.values?.tags;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.trim()) return [raw];
  return [];
}

function caseTraceId(row: DatasetRow): string | undefined {
  const v = row.values?.trace_id ?? row.values?.traceId;
  return v != null && String(v) ? String(v) : undefined;
}

export function DatasetDetailBody({
  datasetId,
  listRow,
  canMutate,
  fullPage,
}: {
  datasetId: string;
  listRow?: DatasetListRow | null;
  canMutate: boolean;
  fullPage?: boolean;
}) {
  const t = useTranslations("evals");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const router = useRouter();
  const { setState } = useEvalsUrlState();
  const [addOpen, setAddOpen] = useState(false);
  const [caseInputText, setCaseInputText] = useState("");
  const [caseExpectedText, setCaseExpectedText] = useState("");

  const detailQuery = useOrgQuery(
    queryKeys.datasets.detail(orgId, datasetId),
    orgId,
    () => datasetsApi.get(orgId!, datasetId),
    { enabled: Boolean(datasetId) },
  );

  const dataset: (Dataset & { rows?: DatasetRow[] }) | null =
    detailQuery.data ?? listRow ?? null;
  const rows: DatasetRow[] = detailQuery.data?.rows ?? [];

  const addMutation = useOrgMutation(
    (vars: Record<string, unknown>) =>
      datasetsApi.addRow(orgId!, datasetId, vars),
    {
      invalidateKeys: [
        queryKeys.datasets.detail(orgId, datasetId),
        queryKeys.datasets.list(orgId),
      ],
      onSuccess: () => {
        toast.success("Case added");
        setCaseInputText("");
        setCaseExpectedText("");
        setAddOpen(false);
      },
      onError: (e) => toast.error(e.message || "Add case failed"),
    },
  );

  const runMutation = useOrgMutation(
    () =>
      offlineExperimentsApi.create(orgId!, {
        name: `Exp · ${dataset?.name ?? datasetId}`,
        dataset_id: datasetId,
      }),
    {
      invalidateKeys: [queryKeys.offlineExperiments.all],
      onSuccess: (res) => {
        const expId = String(res.experiment?.id ?? "");
        toast.success("Experiment created");
        setState({
          tab: "experiments",
          experimentId: expId || undefined,
          datasetId: undefined,
        });
        if (fullPage && expId) {
          router.push(
            `/evals?tab=experiments&experimentId=${encodeURIComponent(expId)}`,
          );
        }
      },
      onError: (e) => toast.error(e.message || "Create experiment failed"),
    },
  );

  const exportHref = useMemo(() => {
    if (!orgId) return null;
    return datasetsApi.exportUrl(
      orgId,
      datasetId,
      `${dataset?.name ?? "dataset"}.jsonl`,
    );
  }, [orgId, datasetId, dataset?.name]);

  if (detailQuery.isLoading && !dataset) {
    return (
      <div className="space-y-3 p-4" data-testid="dataset-detail-loading">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (detailQuery.error && !dataset) {
    return (
      <Panel tone="flat" padding="md" className="m-4" role="alert">
        <p className="m-0 text-sm text-[var(--text-secondary)]">
          {t("datasets.detail.loadError")}
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="mt-2 min-h-11"
          onClick={() => void detailQuery.refetch()}
        >
          {t("common.retry")}
        </Button>
      </Panel>
    );
  }

  if (!dataset) {
    return (
      <div className="p-4 text-sm text-[var(--text-muted)]">
        {t("datasets.detail.selectPrompt")}
      </div>
    );
  }

  return (
    <div
      className={fullPage ? "space-y-4" : "space-y-4 p-4"}
      data-testid="dataset-detail-body"
    >
      <div className="space-y-1">
        <p className="m-0 text-sm text-[var(--text-secondary)]">
          {dataset.description || t("datasets.detail.noDescription")}
        </p>
        <p className="m-0 text-xs text-[var(--text-muted)]">
          {t("datasets.col.cases")}: {dataset.row_count ?? rows.length}
          {" · "}
          {formatRelativeTime(dataset.created_at)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {canMutate ? (
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            onClick={() => setAddOpen(true)}
            data-testid="dataset-add-cases"
          >
            {t("datasets.detail.addCases")}
          </Button>
        ) : null}
        {canMutate ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="min-h-11"
            loading={runMutation.isPending}
            onClick={() => void runMutation.mutateAsync()}
            data-testid="dataset-run-experiment"
          >
            {t("datasets.detail.runExperiment")}
          </Button>
        ) : null}
        {exportHref ? (
          <Button asChild size="sm" variant="ghost" className="min-h-11">
            <a href={exportHref} download>
              {t("datasets.detail.export")}
            </a>
          </Button>
        ) : null}
        {!fullPage ? (
          <Button asChild size="sm" variant="ghost" className="min-h-11">
            <Link href={`/evals/datasets/${encodeURIComponent(datasetId)}`}>
              {t("datasets.detail.openFull")}
            </Link>
          </Button>
        ) : null}
      </div>

      <div data-testid="dataset-cases">
        {rows.length === 0 ? (
          <p className="m-0 text-sm text-[var(--text-muted)]">
            {t("datasets.detail.noCases")}
          </p>
        ) : (
          rows.map((row) => (
            <DatasetCaseRow
              key={row.id}
              inputPreview={caseInput(row)}
              expected={caseExpected(row)}
              tags={caseTags(row)}
              traceId={caseTraceId(row)}
            />
          ))
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("datasets.detail.addCasesTitle")}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={caseInputText}
            onChange={(e) => setCaseInputText(e.target.value)}
            placeholder={t("datasets.detail.inputPlaceholder")}
            rows={4}
          />
          <Input
            value={caseExpectedText}
            onChange={(e) => setCaseExpectedText(e.target.value)}
            placeholder={t("datasets.detail.expectedPlaceholder")}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAddOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!caseInputText.trim() || addMutation.isPending}
              loading={addMutation.isPending}
              onClick={() =>
                void addMutation.mutateAsync({
                  input: caseInputText.trim(),
                  expected_output: caseExpectedText.trim() || undefined,
                })
              }
            >
              {t("datasets.detail.addCase")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function DatasetDetailPanel({
  datasetId,
  listRow,
  open,
  onClose,
  onPrev,
  onNext,
  canMutate,
  mobileDrawer = true,
  fullPage = false,
}: DatasetDetailPanelProps) {
  const t = useTranslations("evals");
  const title = listRow?.name ?? t("datasets.detail.panelTitle");

  if (fullPage) {
    return (
      <DatasetDetailBody
        datasetId={datasetId}
        listRow={listRow}
        canMutate={canMutate}
        fullPage
      />
    );
  }

  return (
    <DetailPanelShell
      open={open}
      onClose={onClose}
      title={title}
      onPrev={onPrev}
      onNext={onNext}
      mobileDrawer={mobileDrawer}
    >
      <DatasetDetailBody
        datasetId={datasetId}
        listRow={listRow}
        canMutate={canMutate}
      />
    </DetailPanelShell>
  );
}
