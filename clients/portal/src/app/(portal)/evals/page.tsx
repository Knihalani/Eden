"use client";

/**
 * /evals — datasets, labeling, studio, synthetic, and eval scores.
 */

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { FlaskConical, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { useQueryTab } from "@/hooks/use-query-tab";
import { cn } from "@/lib/utils";

const TABS = ["eval", "datasets", "labeling", "studio", "synthetic"] as const;

const EvalView = dynamic(() => import("../observability/eval/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const DatasetsView = dynamic(() => import("../datasets/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const LabelingView = dynamic(() => import("../labeling/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const StudioView = dynamic(() => import("../studio/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const SyntheticView = dynamic(() => import("../synthetic/page"), {
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
    <PageContent size="wide">
      <PageHeader
        title="Evals"
        eyebrow="Observe"
        subtitle="Score traces, curate datasets, label ground truth, and generate synthetic cases."
        icon={FlaskConical}
        description="Author and run evaluations without leaving this surface."
      />

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
            {t === "eval" ? "Scores" : t}
          </button>
        ))}
      </div>

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
    </PageContent>
  );
}

export default function EvalsPage() {
  return (
    <Suspense fallback={<TabLoading />}>
      <EvalsInner />
    </Suspense>
  );
}
