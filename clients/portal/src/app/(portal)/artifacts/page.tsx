"use client";

import Link from "next/link";
import { Suspense } from "react";
import { Loader2, Package } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, DetailPanelShell } from "@/components/portal-os";
import { ArtifactDetailPanel } from "@/components/artifacts/ArtifactDetailPanel";
import { NoOrgState } from "@/components/ui/no-org-state";

import { ArtifactsList } from "./_components/artifacts-list";
import { useArtifactsPage } from "./_components/use-artifacts-page";

function ArtifactsPageInner() {
  const a = useArtifactsPage();

  if (!a.currentOrg) {
    return <NoOrgState feature="Artifacts" icon={Package} />;
  }

  return (
    <div data-wave4-improve-artifacts="completed">
      <CoreResourcePage
        header={
          <PageHeader
            title="Artifacts"
            description="Production traces become Artifacts — versioned, evidence-gated runtime fixes."
            actions={
              <nav
                data-testid="artifacts-related-strip"
                aria-label="Related"
                className="flex flex-wrap items-center gap-x-space-3 gap-y-1 text-xs text-[var(--text-muted)]"
              >
                <Link href="/issues" className="text-[var(--accent)] hover:underline">
                  Issues
                </Link>
                <Link href="/improve" className="text-[var(--accent)] hover:underline">
                  Queue
                </Link>
                <Link href="/ledger" className="text-[var(--accent)] hover:underline">
                  Ledger
                </Link>
                <Link href="/prompts" className="text-[var(--accent)] hover:underline">
                  Prompts
                </Link>
              </nav>
            }
          />
        }
        table={
          <ArtifactsList
            artifacts={a.artifacts}
            filtered={a.filtered}
            loading={a.loading}
            error={a.error}
            isFetching={a.artifactsQuery.isFetching}
            onRetry={() => void a.artifactsQuery.refetch()}
            tab={a.tab}
            setTab={a.setTab}
            kpi={a.kpi}
            filterActive={a.filterActive}
            filteredEmpty={a.filteredEmpty}
            artifactId={a.artifactId}
            selectedIds={a.selectedIds}
            toggleSelect={a.toggleSelect}
            setSelectedIds={a.setSelectedIds}
            setUrlState={a.setUrlState}
            nlAgent={a.nlAgent}
            setNlAgent={a.setNlAgent}
            nlText={a.nlText}
            setNlText={a.setNlText}
            doAuthor={a.doAuthor}
            doExport={a.doExport}
            doArchive={a.doArchive}
            promoteWarn={a.promoteWarn}
            promoteTarget={a.promoteTarget}
            promoteBusy={a.promoteBusy}
            setPromoteWarn={a.setPromoteWarn}
            setPromoteTarget={a.setPromoteTarget}
            doPromote={a.doPromote}
          />
        }
        detail={
          a.selected ? (
            <DetailPanelShell
              open
              onClose={() => a.setUrlState({ artifactId: undefined })}
              title={a.selected.name ?? "Artifact"}
              onPrev={
                a.selectedIndex > 0
                  ? () => a.setUrlState({ artifactId: a.filtered[a.selectedIndex - 1]!.id })
                  : undefined
              }
              onNext={
                a.selectedIndex >= 0 && a.selectedIndex < a.filtered.length - 1
                  ? () => a.setUrlState({ artifactId: a.filtered[a.selectedIndex + 1]!.id })
                  : undefined
              }
            >
              <ArtifactDetailPanel
                artifact={a.selected}
                orgId={a.currentOrg.id}
                showPromote={
                  a.selected.mode === "shadow" || a.artifactMode(a.selected) === "shadow"
                }
                promoteBusy={a.promoteBusy}
                onPromote={() => void a.doPromote(a.selected!)}
                onArchive={() => void a.doArchive([a.selected!.id])}
              />
            </DetailPanelShell>
          ) : null
        }
      />
    </div>
  );
}

export default function ArtifactsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <ArtifactsPageInner />
    </Suspense>
  );
}
