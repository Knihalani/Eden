"use client";

/**
 * /evals — datasets, labeling, studio, synthetic, and eval scores.
 */

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { FlaskConical, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { useQueryTab } from "@/hooks/use-query-tab";
import { cn } from "@/lib/utils";

const TABS = ["eval", "playgrounds", "experiments", "datasets", "labeling", "studio", "synthetic"] as const;

const EvalView = dynamic(() => import("@/app/(portal)/observability/eval/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const DatasetsView = dynamic(() => import("@/app/(portal)/datasets/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const PlaygroundsView = dynamic(() => import("@/app/(portal)/playgrounds/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const ExperimentsView = dynamic(() => import("@/app/(portal)/experiments/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const LabelingView = dynamic(() => import("@/app/(portal)/labeling/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const StudioView = dynamic(() => import("@/app/(portal)/studio/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const SyntheticView = dynamic(() => import("@/app/(portal)/synthetic/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});

function TabLoading() {
  return (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

function EvalsInner() {
  const [tab, setTab] = useQueryTab("tab", TABS, "eval");

  return (
    <CoreResourcePage
      size="wide"
      header={
        <PageHeader
          title="Evals"
          eyebrow="Evaluate"
          subtitle="Score traces → datasets → playground → experiments → online scoring. Empty tabs teach the loop."
          icon={FlaskConical}
          description="Author and run evaluations without leaving this surface. Studio/synthetic are live metric & QA tools — not stubs."
        />
      }
      toolbar={
        <div
          role="tablist"
          aria-label="Evals sections"
          className="mb-6 flex flex-wrap gap-1 border-b border-[var(--border-default)]"
        >
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2 text-sm capitalize transition-colors",
                tab === t
                  ? "border-b-2 border-[var(--accent)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
              )}
            >
              {t === "eval" ? "Scores" : t === "playgrounds" ? "Playground" : t}
            </button>
          ))}
        </div>
      }
      table={
        <>
      {tab === "eval" && (
        <EmbeddedSurface>
          <EvalView />
        </EmbeddedSurface>
      )}
      {tab === "datasets" && (
        <EmbeddedSurface>
          <DatasetsView />
        </EmbeddedSurface>
      )}
      {tab === "playgrounds" && (
        <EmbeddedSurface>
          <PlaygroundsView />
        </EmbeddedSurface>
      )}
      {tab === "experiments" && (
        <EmbeddedSurface>
          <ExperimentsView />
        </EmbeddedSurface>
      )}
      {tab === "labeling" && (
        <EmbeddedSurface>
          <LabelingView />
        </EmbeddedSurface>
      )}
      {tab === "studio" && (
        <EmbeddedSurface>
          <StudioView />
        </EmbeddedSurface>
      )}
      {tab === "synthetic" && (
        <EmbeddedSurface>
          <SyntheticView />
        </EmbeddedSurface>
      )}
        </>
      }
    />
  );
}

export default function EvalsPage() {
  return (
    <Suspense fallback={<TabLoading />}>
      <EvalsInner />
    </Suspense>
  );
}
