"use client";

import Link from "next/link";
import { ArrowLeft, Columns3, Keyboard, RefreshCw } from "lucide-react";
import { PageContent } from "@/components/layout/page-content";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { useLabelingQueue } from "./_components/use-labeling-queue";
import { QueueHotkeysStrip } from "./_components/queue-hotkeys-strip";
import { QueueTranscript } from "./_components/queue-transcript";
import { QueueLabelPanel } from "./_components/queue-label-panel";
import { QueueExport } from "./_components/queue-export";

export default function LabelingQueueBoardPage() {
  const q = useLabelingQueue();

  if (!q.currentOrg) return <NoOrgState feature="Annotation queue" />;

  return (
    <PageContent size="wide">
      <div data-wave-e5-labeling="queue" className="contents">
        <PageHeader
          eyebrow="Evaluate"
          title="Labeling workstation"
          subtitle="Transcript · schema labels · hotkeys 1–9 · push to dataset."
          icon={Columns3}
          embedded={q.embedded}
          actions={
            <>
              <Button asChild variant="outline" className="h-8 max-md:min-h-11">
                <Link href="/evals?tab=labeling">
                  <ArrowLeft className="h-3.5 w-3.5" /> Back
                </Link>
              </Button>
              <Button
                variant="ghost"
                className="hidden h-8 max-md:min-h-11 sm:inline-flex"
                onClick={() => q.setShowCheat((v) => !v)}
              >
                <Keyboard className="h-3.5 w-3.5" /> Shortcuts
              </Button>
              <Button
                onClick={() => void q.load()}
                variant="outline"
                className="h-8 max-md:min-h-11"
                disabled={q.loading}
                loading={q.loading}
                aria-label="Refresh board"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </>
          }
        />

        {q.loadError ? (
          <ErrorState
            title="Could not load labeling board"
            message={q.loadError}
            className="mb-4"
            action={
              <Button
                onClick={() => void q.load()}
                variant="outline"
                size="sm"
                className="h-8 max-md:min-h-11"
                disabled={q.loading}
                loading={q.loading}
              >
                Try again
              </Button>
            }
          />
        ) : null}

        {!q.loadError ? (
          <>
            <QueueHotkeysStrip labels={q.labels} showCheat={q.showCheat} />

            <div className="mb-space-3 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
              <span>
                Schema: {String(q.schema.type || "binary")} · labels [{q.labels.join(", ")}]
              </span>
              {q.iaa ? (
                <span>
                  IAA κ={q.iaa.kappa} (n={q.iaa.n}, agree {(q.iaa.agreement_rate * 100).toFixed(0)}%)
                </span>
              ) : (
                <span>IAA: add dual labels in payload to compute κ</span>
              )}
            </div>

            <div className="mb-space-4">
              <QueueExport
                datasetId={q.datasetId}
                onDatasetIdChange={q.setDatasetId}
                onPush={q.exportDataset}
                exporting={q.exporting}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <QueueTranscript
                loading={q.loading}
                queueLength={q.queue.length}
                active={q.active}
                transcript={q.transcript}
              />
              <QueueLabelPanel
                labels={q.labels}
                notes={q.notes}
                onNotesChange={q.setNotes}
                active={q.active}
                queue={q.queue}
                onApplyLabel={q.applyLabel}
                onSkip={q.skip}
                onSelectItem={q.setActiveId}
              />
            </div>
          </>
        ) : null}
      </div>
    </PageContent>
  );
}
