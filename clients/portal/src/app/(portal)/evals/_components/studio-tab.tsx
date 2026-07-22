"use client";

import { useTranslations } from "next-intl";
import { CheckCircle2, FileText, Layers, Plus, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { QueryState } from "@/components/ui/query-state";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";
import type { MetricStudioMetric, MetricStudioTemplate } from "@/lib/api";
import { useStudioTab } from "../_hooks/use-studio-tab";

export type StudioTabProps = {
  canMutate?: boolean;
};

function isProduction(status: string | undefined): boolean {
  return status === "production";
}

export function StudioTab({ canMutate = true }: StudioTabProps) {
  const t = useTranslations("evals");
  const studio = useStudioTab();
  const [preview, setPreview] = useState<MetricStudioTemplate | null>(null);
  const [metricDetail, setMetricDetail] = useState<MetricStudioMetric | null>(
    null,
  );

  return (
    <div className="space-y-4" data-testid="evals-studio-tab">
      <Tabs
        value={studio.subTab}
        onValueChange={(v) =>
          studio.requestSubTab(v as "templates" | "examples" | "metrics")
        }
      >
        <TabsList
          variant="underline"
          aria-label={t("studio.sectionsAria")}
          className="mb-3 h-auto w-full justify-start"
        >
          <TabsTrigger variant="underline" value="templates" className="min-h-11">
            {t("studio.templates")}
          </TabsTrigger>
          <TabsTrigger variant="underline" value="examples" className="min-h-11">
            {t("studio.fromExamples")}
          </TabsTrigger>
          <TabsTrigger variant="underline" value="metrics" className="min-h-11">
            {t("studio.myMetrics")}
          </TabsTrigger>
        </TabsList>

        {studio.subTab === "templates" ? (
          <QueryState
            loading={studio.templatesQuery.isLoading}
            error={studio.templatesQuery.error}
            data={studio.templates}
            onRetry={() => void studio.templatesQuery.refetch()}
            isEmpty={(rows) => rows.length === 0}
            emptySlot={
              <EmptyState
                icon={FileText}
                title={t("studio.templatesEmptyTitle")}
                description={t("studio.templatesEmptyBody")}
                variant="plain"
              />
            }
          >
            {(templates) => (
              <DataTable
                rows={templates}
                rowKey={(tpl) => tpl.id}
                columns={[
                  {
                    key: "name",
                    header: t("studio.colName"),
                    sortable: true,
                    cell: (tpl) => (
                      <span className="font-medium">{tpl.name}</span>
                    ),
                  },
                  {
                    key: "domain",
                    header: t("studio.colDomain"),
                    cell: (tpl) => (
                      <span className="text-xs text-[var(--text-secondary)]">
                        {tpl.domain}
                      </span>
                    ),
                  },
                  {
                    key: "criteria",
                    header: t("studio.colCriteria"),
                    align: "right",
                    cell: (tpl) => (
                      <span className="text-[var(--text-secondary)]">
                        {tpl.criteria?.length ?? 0}
                      </span>
                    ),
                  },
                  {
                    key: "id",
                    header: "",
                    align: "right",
                    cell: (tpl) => (
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => setPreview(tpl)}
                        >
                          {t("studio.preview")}
                        </Button>
                        {canMutate ? (
                          <Button
                            type="button"
                            size="sm"
                            className="min-h-11"
                            onClick={() =>
                              studio.useTemplate({
                                name: tpl.name,
                                domain: tpl.domain || "general",
                                notes: tpl.notes,
                              })
                            }
                          >
                            <Wand2 className="h-3.5 w-3.5" aria-hidden />
                            {t("studio.useTemplate")}
                          </Button>
                        ) : null}
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </QueryState>
        ) : null}

        {studio.subTab === "examples" ? (
          <Panel tone="flat" padding="md" className="space-y-4">
            {!canMutate ? (
              <p className="text-xs text-[var(--text-muted)]">
                {t("viewerReadonly")}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  {t("studio.metricName")}
                </span>
                <Input
                  value={studio.name}
                  onChange={(e) => studio.setName(e.target.value)}
                  disabled={!canMutate || studio.fromExamplesMutation.isPending}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  {t("studio.domain")}
                </span>
                <Input
                  value={studio.domain}
                  onChange={(e) => studio.setDomain(e.target.value)}
                  disabled={!canMutate || studio.fromExamplesMutation.isPending}
                />
              </label>
            </div>

            <div className="space-y-3">
              {studio.examples.map((ex, i) => (
                <Panel key={i} tone="inset" padding="sm" className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[var(--text-muted)]">
                      {t("studio.exampleN", { n: i + 1 })}
                    </span>
                    {canMutate && studio.examples.length > 2 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="min-h-11"
                        onClick={() =>
                          studio.setExamples((prev) =>
                            prev.filter((_, idx) => idx !== i),
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  <Textarea
                    value={ex.input}
                    onChange={(e) =>
                      studio.setExamples((prev) =>
                        prev.map((row, idx) =>
                          idx === i ? { ...row, input: e.target.value } : row,
                        ),
                      )
                    }
                    placeholder={t("studio.inputPlaceholder")}
                    disabled={!canMutate}
                    rows={2}
                  />
                  <Textarea
                    value={ex.output}
                    onChange={(e) =>
                      studio.setExamples((prev) =>
                        prev.map((row, idx) =>
                          idx === i ? { ...row, output: e.target.value } : row,
                        ),
                      )
                    }
                    placeholder={t("studio.outputPlaceholder")}
                    disabled={!canMutate}
                    rows={2}
                  />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select
                      value={ex.label}
                      onValueChange={(v) =>
                        studio.setExamples((prev) =>
                          prev.map((row, idx) =>
                            idx === i
                              ? {
                                  ...row,
                                  label: v as "pass" | "fail",
                                }
                              : row,
                          ),
                        )
                      }
                      disabled={!canMutate}
                    >
                      <SelectTrigger className="min-h-11">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pass">pass</SelectItem>
                        <SelectItem value="fail">fail</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={ex.rationale ?? ""}
                      onChange={(e) =>
                        studio.setExamples((prev) =>
                          prev.map((row, idx) =>
                            idx === i
                              ? { ...row, rationale: e.target.value }
                              : row,
                          ),
                        )
                      }
                      placeholder={t("studio.rationalePlaceholder")}
                      disabled={!canMutate}
                    />
                  </div>
                </Panel>
              ))}
            </div>

            {canMutate ? (
              <div className="flex flex-wrap items-center gap-2">
                {studio.examples.length < 5 ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() =>
                      studio.setExamples((prev) => [
                        ...prev,
                        {
                          input: "",
                          output: "",
                          label: "pass",
                          rationale: "",
                        },
                      ])
                    }
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    {t("studio.addExample")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  className="min-h-11 sm:ml-auto"
                  loading={studio.fromExamplesMutation.isPending}
                  onClick={() => studio.generateFromExamples()}
                >
                  <Wand2 className="h-3.5 w-3.5" aria-hidden />
                  {t("studio.generate")}
                </Button>
              </div>
            ) : null}

            {studio.generated ? (
              <Panel tone="inset" padding="md" className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    {t("studio.generatedRubric")}
                  </h3>
                  <span className="text-xs text-[var(--text-muted)]">
                    ~{studio.generated.rubric_tokens} tokens
                  </span>
                </div>
                <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap text-xs">
                  {studio.generated.rubric_prompt}
                </pre>
                {canMutate ? (
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11"
                      onClick={() => studio.setGenerated(null)}
                    >
                      {t("studio.discard")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      loading={studio.createMetricMutation.isPending}
                      onClick={() => studio.saveGeneratedMetric()}
                    >
                      {t("studio.saveMetric")}
                    </Button>
                  </div>
                ) : null}
              </Panel>
            ) : null}
          </Panel>
        ) : null}

        {studio.subTab === "metrics" ? (
          <QueryState
            loading={studio.metricsQuery.isLoading}
            error={studio.metricsQuery.error}
            data={studio.metrics}
            onRetry={() => void studio.metricsQuery.refetch()}
            isEmpty={(rows) => rows.length === 0}
            emptySlot={
              <EmptyState
                icon={Layers}
                title={t("studio.metricsEmptyTitle")}
                description={t("studio.metricsEmptyBody")}
                variant="plain"
              />
            }
          >
            {(metrics) => (
              <DataTable
                rows={metrics}
                rowKey={(m) => m.metric_id}
                defaultSort={{ key: "created_at", direction: "desc" }}
                columns={[
                  {
                    key: "name",
                    header: t("studio.colName"),
                    sortable: true,
                    cell: (m) => (
                      <span className="font-medium">{m.name}</span>
                    ),
                  },
                  {
                    key: "version",
                    header: t("studio.colVersion"),
                    cell: (m) => (
                      <span className="font-mono text-xs">{m.version}</span>
                    ),
                  },
                  {
                    key: "status",
                    header: t("studio.colStatus"),
                    cell: (m) =>
                      isProduction(m.status) ? (
                        <Badge variant="secondary">
                          <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden />
                          Production
                        </Badge>
                      ) : (
                        <Badge variant="outline">{m.status || "draft"}</Badge>
                      ),
                  },
                  {
                    key: "created_at",
                    header: t("studio.colCreated"),
                    sortable: true,
                    cell: (m) => (
                      <span className="text-xs text-[var(--text-muted)]">
                        {m.created_at
                          ? new Date(m.created_at).toLocaleString()
                          : "—"}
                      </span>
                    ),
                  },
                  {
                    key: "metric_id",
                    header: "",
                    align: "right",
                    cell: (m) => (
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => setMetricDetail(m)}
                        >
                          {t("studio.view")}
                        </Button>
                        {canMutate && !isProduction(m.status) ? (
                          <Button
                            type="button"
                            size="sm"
                            className="min-h-11"
                            loading={studio.approveMutation.isPending}
                            onClick={() => studio.approveMetric(m)}
                          >
                            {t("studio.approve")}
                          </Button>
                        ) : null}
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </QueryState>
        ) : null}
      </Tabs>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{preview?.name}</DialogTitle>
            <DialogDescription>
              {t("studio.domain")}: {preview?.domain}
              {preview?.version ? ` · v${preview.version}` : ""}
            </DialogDescription>
          </DialogHeader>
          <ol className="list-inside list-decimal space-y-2 text-xs">
            {(preview?.criteria ?? []).map((c, i) => (
              <li key={i} className="whitespace-pre-wrap">
                {c}
              </li>
            ))}
          </ol>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setPreview(null)}
            >
              {t("cancel")}
            </Button>
            {canMutate && preview ? (
              <Button
                type="button"
                className="min-h-11"
                onClick={() => {
                  studio.useTemplate({
                    name: preview.name,
                    domain: preview.domain || "general",
                    notes: preview.notes,
                  });
                  setPreview(null);
                }}
              >
                {t("studio.useTemplate")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!metricDetail}
        onOpenChange={(o) => !o && setMetricDetail(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{metricDetail?.name}</DialogTitle>
            <DialogDescription>
              {metricDetail?.domain ?? "—"} · {metricDetail?.version} ·{" "}
              {metricDetail?.status}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-xs text-[var(--text-secondary)]">
            <p className="font-mono break-all">{metricDetail?.metric_id}</p>
            <p className="font-mono break-all">{metricDetail?.rubric_id}</p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setMetricDetail(null)}
            >
              {t("cancel")}
            </Button>
            {canMutate &&
            metricDetail &&
            !isProduction(metricDetail.status) ? (
              <Button
                type="button"
                className="min-h-11"
                loading={studio.approveMutation.isPending}
                onClick={() => {
                  studio.approveMetric(metricDetail);
                  setMetricDetail(null);
                }}
              >
                {t("studio.approve")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
