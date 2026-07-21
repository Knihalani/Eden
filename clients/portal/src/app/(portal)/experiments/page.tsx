"use client";

import { Suspense } from "react";
import { BarChart3, RefreshCw, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import {
  CoreResourcePage,
  ResourceOsToolbar,
} from "@/components/portal-os";
import { ExperimentsList } from "./_components/experiments-list";
import { ComparePanel } from "./_components/compare-panel";
import {
  useExperimentsPage,
  WAVE_E4_EXPERIMENTS_COMPLETED,
  WAVE_E4_COMPARE_MATRIX_COMPLETED,
  WAVE_E4_BASELINE_COMPLETED,
  WAVE_E4_DIFF_GRADES_COMPLETED,
} from "./_components/use-experiments-page";
import { WAVE_E4_COMPARE_MATRIX_UI } from "./_components/compare-matrix";

void WAVE_E4_EXPERIMENTS_COMPLETED;
void WAVE_E4_COMPARE_MATRIX_COMPLETED;
void WAVE_E4_BASELINE_COMPLETED;
void WAVE_E4_DIFF_GRADES_COMPLETED;
void WAVE_E4_COMPARE_MATRIX_UI;

function ExperimentsPageInner() {
  const {
    currentOrg,
    embedded,
    rows,
    loading,
    loadError,
    load,
    summary,
    datapoints,
    compareMeta,
    summaryLoading,
    compareError,
    loadCompare,
    selected,
    toggleSelect,
    compareSelected,
    experimentId,
    selectedRow,
    selectedIndex,
    effectiveBaselineId,
    baselineRow,
    baselineCandidates,
    setBaseline,
    layout,
    setLayout,
    diffMode,
    setDiffMode,
    failuresOnly,
    setFailuresOnly,
    diffOpen,
    setDiffOpen,
    runningId,
    runError,
    setRunError,
    runExperiment,
    closeDetail,
    openExperiment,
  } = useExperimentsPage();

  if (!currentOrg) return <NoOrgState feature="Experiments" />;

  return (
    <div
      data-wave-e4-experiments="shell"
      data-wave-e6-eval="experiments"
      data-wave-e6-keyboard="shell"
    >
    <CoreResourcePage
      size="wide"
      header={
        <PageHeader
          eyebrow="Evaluate"
          title="Offline experiments"
          subtitle="Baseline · deltas · Diff · grades · Summary | List | Grid."
          icon={BarChart3}
          embedded={embedded}
          actions={
            <div
              className="flex flex-wrap items-center gap-2"
              data-wave-e4-cta="hierarchy"
            >
              <Button
                className="h-8 min-h-11 max-md:hidden md:min-h-8"
                disabled={selected.size !== 2}
                onClick={compareSelected}
                data-testid="experiments-compare-cta"
                data-wave-e4-cta="compare"
                data-wave-e6-mobile="hide-bulk"
              >
                Compare selected ({selected.size}/2)
              </Button>
              <Button
                onClick={load}
                variant="ghost"
                className="hidden h-8 min-h-11 sm:inline-flex md:min-h-8"
                disabled={loading}
                loading={loading}
                data-wave-e4-cta="refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
            </div>
          }
        />
      }
      toolbar={
        <ResourceOsToolbar
          resourceKey="experiments"
          exportRows={rows.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            dataset_id: r.dataset_id,
          }))}
          exportFilename="experiments.csv"
        />
      }
      table={
        <ExperimentsList
          rows={rows}
          loading={loading}
          loadError={loadError}
          runError={runError}
          selected={selected}
          runningId={runningId}
          onLoad={load}
          onDismissRunError={() => setRunError(null)}
          onToggleSelect={toggleSelect}
          onRun={runExperiment}
          onOpen={openExperiment}
        />
      }
      detail={
        experimentId ? (
          <ComparePanel
            selectedRow={selectedRow}
            baselineRow={baselineRow}
            effectiveBaselineId={effectiveBaselineId}
            baselineCandidates={baselineCandidates}
            summary={summary}
            datapoints={datapoints}
            compareMeta={compareMeta}
            summaryLoading={summaryLoading}
            compareError={compareError}
            layout={layout}
            diffMode={diffMode}
            failuresOnly={failuresOnly}
            diffOpen={diffOpen}
            onClose={closeDetail}
            onPrev={
              selectedIndex > 0
                ? () => openExperiment(rows[selectedIndex - 1]!.id)
                : undefined
            }
            onNext={
              selectedIndex >= 0 && selectedIndex < rows.length - 1
                ? () => openExperiment(rows[selectedIndex + 1]!.id)
                : undefined
            }
            onSetBaseline={setBaseline}
            onSetLayout={setLayout}
            onSetDiffMode={setDiffMode}
            onSetFailuresOnly={setFailuresOnly}
            onSetDiffOpen={setDiffOpen}
            onRetryCompare={() => {
              if (!experimentId) return;
              void loadCompare(experimentId, effectiveBaselineId);
            }}
          />
        ) : null
      }
    />
    </div>
  );
}

export default function ExperimentsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <ExperimentsPageInner />
    </Suspense>
  );
}
