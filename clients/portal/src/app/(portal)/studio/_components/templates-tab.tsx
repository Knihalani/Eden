"use client";

import { useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { metricStudioApi } from "@/lib/api";
import type { MetricStudioTemplate } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import { FileText, Loader2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  featureGatedErrorCopy,
} from "@/lib/feature-flag-error";
import type { TemplateSeed } from "./studio-helpers";

export function TemplatesTab({
  orgId,
  onUseTemplate,
}: {
  orgId: string;
  onUseTemplate: (seed: TemplateSeed) => void;
}) {
  const [openTemplate, setOpenTemplate] = useState<MetricStudioTemplate | null>(null);
  const templatesQuery = useOrgQuery(
    queryKeys.studio.templates(orgId),
    orgId,
    async () => {
      const data = await metricStudioApi.listTemplates(orgId);
      return data.templates;
    },
  );
  const templates = templatesQuery.data ?? [];
  const loading = templatesQuery.isLoading;
  if (templatesQuery.error && !loading) {
    const copy = featureGatedErrorCopy(
      templatesQuery.error,
      "Could not load templates",
    );
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={
          <Button
            variant="default"
            className="h-8 max-md:min-h-11"
            onClick={() => void templatesQuery.refetch()}
          >
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-3" data-wave-e5-studio="templates">
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" />
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No templates yet"
          description="Built-in rubric templates appear here when available."
        />
      ) : (
        <div className="overflow-hidden border-y border-[var(--border-subtle)] py-space-2">
          <DataTable
            columns={[
              {
                key: "name",
                header: "Name",
                sortable: true,
                cell: (tpl) => <span className="font-medium text-[var(--text-primary)]">{tpl.name}</span>,
              },
              {
                key: "domain",
                header: "Domain",
                cell: (tpl) => (
                  <span className="text-xs text-[var(--text-secondary)]">
                    {tpl.domain}
                  </span>
                ),
              },
              {
                key: "criteria",
                header: "Criteria",
                align: "right",
                cell: (tpl) => <span className="text-[var(--text-secondary)]">{tpl.criteria?.length ?? 0}</span>,
              },
              {
                key: "notes",
                header: "Preview",
                cell: (tpl) => (
                  <span className="text-[var(--text-muted)] max-w-md truncate inline-block">
                    {tpl.criteria?.[0] ?? tpl.notes ?? "—"}
                  </span>
                ),
              },
              {
                key: "id",
                header: "Action",
                align: "right",
                cell: (tpl) => (
                  <Button
                    variant="default"
                    size="sm"
                    className="h-8 max-md:min-h-11"
                    onClick={() => setOpenTemplate(tpl)}
                    aria-label={`Use template ${tpl.name}`}
                  >
                    <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                    Use template
                  </Button>
                ),
              },
            ]}
            rows={templates}
            rowKey={(tpl) => tpl.id}
            defaultSort={{ key: "name", direction: "asc" }}
            emptyTitle="No templates yet"
            emptyDescription="Built-in rubric templates appear here when available."
            pageSize={25}
          />
        </div>
      )}

      <Dialog open={!!openTemplate} onOpenChange={(o) => !o && setOpenTemplate(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
              {openTemplate?.name}
            </DialogTitle>
            <DialogDescription>
              Domain: {openTemplate?.domain}
              {openTemplate?.version ? ` · v${openTemplate.version}` : ""}
            </DialogDescription>
          </DialogHeader>
          {openTemplate?.notes && (
            <p className="text-xs text-[var(--text-secondary)]">{openTemplate.notes}</p>
          )}
          <ol className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[50vh] space-y-2 list-decimal list-inside">
            {(openTemplate?.criteria ?? []).map((c, i) => (
              <li key={i} className="whitespace-pre-wrap">
                {c}
              </li>
            ))}
          </ol>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-8 max-md:min-h-11"
              onClick={() => setOpenTemplate(null)}
              aria-label="Close template preview"
            >
              Close
            </Button>
            <Button
              variant="default"
              className="h-8 max-md:min-h-11"
              onClick={() => {
                if (!openTemplate) return;
                onUseTemplate({
                  name: openTemplate.name,
                  domain: openTemplate.domain || "general",
                  notes: openTemplate.notes,
                });
                setOpenTemplate(null);
              }}
              aria-label={`Start from template ${openTemplate?.name}`}
            >
              <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
              Start from template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
