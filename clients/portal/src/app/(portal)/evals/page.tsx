"use client";

/**
 * /evals — datasets, labeling, studio, synthetic, and eval scores.
 */

import { Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ExternalLink, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { Button } from "@/components/ui/button";
import { useQueryTab } from "@/hooks/use-query-tab";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";

/** First-run order: dataset → playground → experiment → scores; advanced tools last. */
const TABS = [
  "datasets",
  "playgrounds",
  "experiments",
  "eval",
  "labeling",
  "studio",
  "synthetic",
] as const;

const TAB_META: Record<
  (typeof TABS)[number],
  { label: string; title: string }
> = {
  datasets: {
    label: "Datasets",
    title: "Golden sets and cases to score against",
  },
  playgrounds: {
    label: "Playground",
    title: "Side-by-side prompt runs before an experiment",
  },
  experiments: {
    label: "Experiments",
    title: "Offline eval runs over a bound dataset",
  },
  eval: {
    label: "Scores",
    title: "Judge versions and failure clusters from scored traces",
  },
  labeling: {
    label: "Labeling",
    title: "Human labels that feed datasets",
  },
  studio: {
    label: "Studio",
    title: "Custom metric rubrics (advanced)",
  },
  synthetic: {
    label: "Synthetic",
    title: "Synthetic QA cases for datasets (advanced)",
  },
};

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
  const [tab, setTab] = useQueryTab("tab", TABS, "datasets");

  return (
    <CoreResourcePage
      size="wide"
      header={
        <PageHeader
          title="Evals"
          eyebrow="Evaluate"
          subtitle="An eval scores agent output against a rubric or expected answer. First-run: dataset → playground → experiment."
          description="Author and run evaluations without leaving this surface. Studio/synthetic are live metric & QA tools — not stubs."
          actions={
            <Button asChild variant="ghost" className="min-h-11">
              <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                Docs
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            </Button>
          }
        />
      }
      toolbar={
        <div
          role="tablist"
          aria-label="Evals sections"
          className="flex flex-wrap gap-1 border-b border-[var(--border-subtle)]"
        >
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              title={TAB_META[t].title}
              onClick={() => setTab(t)}
              className={cn(
                "min-h-11 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                tab === t
                  ? "border-b-2 border-[var(--accent)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
              )}
            >
              {TAB_META[t].label}
            </button>
          ))}
        </div>
      }
      table={
        <>
          {tab === "datasets" ? (
            <p className="mb-4 text-sm text-[var(--text-muted)]">
              Start here: create a dataset, then open{" "}
              <Link
                href="/evals?tab=playgrounds"
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Playground
              </Link>{" "}
              to compare prompts. Need traces first?{" "}
              <a
                href={DOCS_QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Docs quickstart
              </a>
              .
            </p>
          ) : null}
          {tab === "studio" ? (
            <p className="mb-4 text-sm text-[var(--text-muted)]">
              Advanced: custom rubrics. First-run path stays dataset → playground → experiment.
            </p>
          ) : null}
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
