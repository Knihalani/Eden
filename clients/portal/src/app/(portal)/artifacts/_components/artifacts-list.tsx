"use client";

import Link from "next/link";
import { Download, Loader2, Package, PenLine, Sparkles } from "lucide-react";

import { BulkActionBar, ResourceOsToolbar } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { issueHref } from "@/lib/portal-cross-links";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { cn } from "@/lib/utils";

import { PromoteOverrideDialog } from "./promote-override-dialog";
import {
  MODE_TABS,
  type ArtifactModeTab,
  type ArtifactRow,
} from "./use-artifacts-page";

type ArtifactsListProps = {
  artifacts: ArtifactRow[];
  filtered: ArtifactRow[];
  loading: boolean;
  error: string | null;
  isFetching: boolean;
  onRetry: () => void;
  tab: ArtifactModeTab;
  setTab: (tab: ArtifactModeTab) => void;
  kpi: { shadow: number; promoted: number; archived: number };
  filterActive: boolean;
  filteredEmpty: boolean;
  artifactId: string | undefined;
  selectedIds: string[];
  toggleSelect: (id: string) => void;
  setSelectedIds: (ids: string[]) => void;
  setUrlState: (patch: { artifactId?: string }) => void;
  nlAgent: string;
  setNlAgent: (v: string) => void;
  nlText: string;
  setNlText: (v: string) => void;
  doAuthor: () => void;
  doExport: (agentId: string) => void;
  doArchive: (ids: string[]) => void;
  promoteWarn: boolean;
  promoteTarget: ArtifactRow | null;
  promoteBusy: boolean;
  setPromoteWarn: (v: boolean) => void;
  setPromoteTarget: (v: ArtifactRow | null) => void;
  doPromote: (a: ArtifactRow, opts?: { force?: boolean }) => void;
};

export function ArtifactsList({
  artifacts,
  filtered,
  loading,
  error,
  isFetching,
  onRetry,
  tab,
  setTab,
  kpi,
  filterActive,
  filteredEmpty,
  artifactId,
  selectedIds,
  toggleSelect,
  setSelectedIds,
  setUrlState,
  nlAgent,
  setNlAgent,
  nlText,
  setNlText,
  doAuthor,
  doExport,
  doArchive,
  promoteWarn,
  promoteTarget,
  promoteBusy,
  setPromoteWarn,
  setPromoteTarget,
  doPromote,
}: ArtifactsListProps) {
  return (
    <>
      <ResourceOsToolbar
        resourceKey="artifacts"
        exportRows={filtered.map((a) => ({
          id: a.id,
          name: a.name ?? "",
          mode: a.mode ?? "",
          agent_id: a.agent_id ?? "",
        }))}
        exportFilename="artifacts.csv"
        className="mb-4"
      />
      {error ? (
        <ErrorState
          title="Could not load artifacts"
          message={error}
          className="mb-4"
          action={
            <Button size="sm" variant="outline" onClick={onRetry} loading={isFetching}>
              Try again
            </Button>
          }
        />
      ) : null}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : error ? null : (
        <>
          <details className="mb-space-4 group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              <PenLine className="h-4 w-4" />
              Author from plain English
            </summary>
            <div className="mt-space-2 flex flex-wrap gap-2">
              <Input
                placeholder="agent_id"
                value={nlAgent}
                onChange={(e) => setNlAgent(e.target.value)}
                aria-label="Agent ID for artifact author"
              />
              <Input
                className="min-w-[240px] flex-1"
                placeholder="Describe the fix…"
                value={nlText}
                onChange={(e) => setNlText(e.target.value)}
                aria-label="Artifact description"
              />
              <Button size="sm" onClick={() => void doAuthor()}>
                <Sparkles className="mr-1 h-4 w-4" />
                Draft shadow
              </Button>
            </div>
          </details>
          <Tabs value={tab} onValueChange={(v) => setTab(v as ArtifactModeTab)}>
            <TabsList
              variant="underline"
              aria-label="Artifact modes"
              className="h-auto w-full justify-start"
              data-testid="artifacts-mode-tabs"
            >
              {MODE_TABS.map((m) => {
                const count =
                  m === "all"
                    ? artifacts.length
                    : m === "shadow"
                      ? kpi.shadow
                      : m === "promoted"
                        ? kpi.promoted
                        : kpi.archived;
                return (
                  <TabsTrigger key={m} value={m} variant="underline" className="min-h-11 capitalize">
                    {m}
                    <span className="ml-1.5 tabular-nums text-[var(--text-muted)]">{count}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <TabsContent value={tab} className="mt-4">
              {filteredEmpty ? (
                <EmptyState
                  variant="plain"
                  icon={Package}
                  title={
                    filterActive && artifacts.length > 0
                      ? `No ${tab} artifacts`
                      : "No artifacts yet"
                  }
                  description={
                    filterActive && artifacts.length > 0
                      ? `Nothing in the ${tab} mode. Switch to All or another mode to see your ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}.`
                      : U20_EMPTY_COPY.artifacts
                  }
                  action={
                    filterActive && artifacts.length > 0 ? (
                      <Button
                        className="min-h-11"
                        variant="outline"
                        onClick={() => setTab("all")}
                        data-testid="artifacts-clear-mode-filter"
                      >
                        Show all artifacts
                      </Button>
                    ) : (
                      <Button className="min-h-11" asChild>
                        <Link href="/issues">View Agent Issues</Link>
                      </Button>
                    )
                  }
                />
              ) : (
                <div
                  className="divide-y divide-[var(--border-subtle)]"
                  data-testid="artifacts-mode-list"
                >
                  {filtered.map((a) => (
                    <div
                      key={a.id}
                      className={cn(
                        "row-select-highlight px-1 py-4 transition-colors",
                        artifactId === a.id &&
                          "bg-[var(--accent-faint)]/40 ring-1 ring-[var(--accent)]/30 rounded-lg is-selected",
                      )}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 flex-1 gap-3">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={selectedIds.includes(a.id)}
                            onChange={() => toggleSelect(a.id)}
                            aria-label={`Select ${a.name}`}
                          />
                          <div className="min-w-0">
                            <button
                              type="button"
                              className="text-left font-medium hover:underline"
                              data-testid="artifacts-select-row"
                              onClick={() => setUrlState({ artifactId: a.id })}
                            >
                              {a.name}
                            </button>
                            <div className="text-xs text-[var(--text-muted)]">
                              {a.agent_id} · {a.mode}
                              {a.cost?.est_usd_per_month != null
                                ? ` · ~$${a.cost.est_usd_per_month}/mo`
                                : ""}
                              {a.cost?.value_score != null
                                ? ` · value ${a.cost.value_score}`
                                : ""}
                            </div>
                            {a.source_issue_id ? (
                              <Link
                                href={issueHref(a.source_issue_id)}
                                className="mt-1 inline-block text-xs text-[var(--accent)] hover:underline"
                              >
                                Source issue
                              </Link>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {a.agent_id ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void doExport(String(a.agent_id))}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
      <PromoteOverrideDialog
        open={promoteWarn && !!promoteTarget}
        promoteTarget={promoteTarget}
        promoteBusy={promoteBusy}
        onClose={() => {
          setPromoteWarn(false);
          setPromoteTarget(null);
        }}
        onForcePromote={(target) => void doPromote(target, { force: true })}
      />
      <BulkActionBar
        count={selectedIds.length}
        onClear={() => setSelectedIds([])}
        actions={[
          {
            label: "Archive",
            variant: "destructive",
            onClick: () => void doArchive(selectedIds),
          },
          {
            label: "Export first agent",
            onClick: () => {
              const first = artifacts.find((a) => selectedIds.includes(a.id) && a.agent_id);
              if (first?.agent_id) void doExport(String(first.agent_id));
            },
          },
        ]}
      />
    </>
  );
}
