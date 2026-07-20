"use client";

/**
 * /evals — Braintrust-like path: dataset → playground → experiment.
 * Primary tabs carry first-run weight; Advanced tools live in overflow.
 */

import { Suspense } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQueryTab } from "@/hooks/use-query-tab";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";

/** First-run path objects (E-01 / E-12). */
const PRIMARY_TABS = ["datasets", "playgrounds", "experiments"] as const;

/** Scores / labeling / studio / synthetic — disclosure overflow. */
const ADVANCED_TABS = ["eval", "labeling", "studio", "synthetic"] as const;

const TABS = [...PRIMARY_TABS, ...ADVANCED_TABS] as const;

type EvalTab = (typeof TABS)[number];

const TAB_META: Record<EvalTab, { label: string; title: string }> = {
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

const PATH_LINKS = [
  { label: "Datasets", href: "/evals?tab=datasets" },
  { label: "Playground", href: "/evals?tab=playgrounds" },
  { label: "Experiments", href: "/evals?tab=experiments" },
  { label: "Promote from Traces", href: "/traces" },
] as const;

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

function isAdvancedTab(tab: EvalTab): boolean {
  return (ADVANCED_TABS as readonly string[]).includes(tab);
}

function EvalsInner() {
  const [tab, setTab] = useQueryTab("tab", TABS, "datasets");
  const advancedActive = isAdvancedTab(tab);

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as EvalTab)}>
      <CoreResourcePage
        size="wide"
        header={
          <PageHeader
            title="Evals"
            eyebrow="Evaluate"
            subtitle="Dataset → playground → experiment. Advanced tools stay in overflow."
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
            data-testid="evals-toolbar"
            className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] pb-1"
          >
            <TabsList
              variant="underline"
              aria-label="Evals primary sections"
              className="h-auto min-w-0 flex-1 justify-start gap-1 overflow-x-auto bg-transparent"
            >
              {PRIMARY_TABS.map((t) => (
                <TabsTrigger
                  key={t}
                  variant="underline"
                  value={t}
                  title={TAB_META[t].title}
                  className="min-h-11 shrink-0"
                >
                  {TAB_META[t].label}
                </TabsTrigger>
              ))}
            </TabsList>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant={advancedActive ? "outline" : "ghost"}
                  className={cn(
                    "min-h-11 shrink-0",
                    advancedActive && "border-[var(--accent)] text-[var(--accent)]",
                  )}
                  aria-label="Advanced eval tools and path links"
                  aria-current={advancedActive ? "page" : undefined}
                >
                  <span className="hidden sm:inline">
                    {advancedActive ? `Advanced · ${TAB_META[tab].label}` : "More"}
                  </span>
                  <span className="sm:hidden">More</span>
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                <DropdownMenuLabel>Advanced</DropdownMenuLabel>
                {ADVANCED_TABS.map((t) => (
                  <DropdownMenuItem
                    key={t}
                    onSelect={() => setTab(t)}
                    title={TAB_META[t].title}
                    className={cn(tab === t && "bg-[var(--accent-bg)] text-[var(--accent)]")}
                  >
                    {TAB_META[t].label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Go to</DropdownMenuLabel>
                {PATH_LINKS.map((l) => (
                  <DropdownMenuItem key={l.href} asChild>
                    <Link href={l.href}>{l.label}</Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
        table={
          <>
            {tab === "datasets" ? (
              <p className="mb-space-4 text-sm text-[var(--text-muted)]">
                Start here: create a dataset, then open{" "}
                <Button asChild variant="link" className="h-auto min-h-0 p-0 text-sm">
                  <Link href="/evals?tab=playgrounds">Playground</Link>
                </Button>{" "}
                to compare prompts. Need traces first?{" "}
                <Button asChild variant="link" className="h-auto min-h-0 p-0 text-sm">
                  <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                    Docs quickstart
                  </a>
                </Button>
                .
              </p>
            ) : null}

            {tab === "playgrounds" ? (
              <div className="mb-space-4 flex flex-wrap items-center gap-space-3 text-sm text-[var(--text-muted)]">
                <p className="min-w-0 flex-1">
                  Scratchpad: re-runs overwrite. Snapshot results with{" "}
                  <span className="font-medium text-[var(--text-secondary)]">
                    Promote → Experiment
                  </span>{" "}
                  after binding a dataset.
                </p>
                <Button asChild variant="outline" className="min-h-11 shrink-0">
                  <Link href="/evals?tab=experiments">Open experiments</Link>
                </Button>
              </div>
            ) : null}

            {tab === "experiments" ? (
              <p className="mb-space-4 text-sm text-[var(--text-muted)]">
                Offline runs over a bound dataset. Playground drafts stay on Playground until
                promoted.
              </p>
            ) : null}

            {tab === "studio" || tab === "synthetic" || tab === "eval" || tab === "labeling" ? (
              <p className="mb-space-4 text-sm text-[var(--text-muted)]">
                Advanced tool. First-run path stays dataset → playground → experiment.
              </p>
            ) : null}

            <TabsContent value="eval" className="mt-0">
              <EmbeddedSurface>
                <EvalView />
              </EmbeddedSurface>
            </TabsContent>
            <TabsContent value="datasets" className="mt-0">
              <EmbeddedSurface>
                <DatasetsView />
              </EmbeddedSurface>
            </TabsContent>
            <TabsContent value="playgrounds" className="mt-0">
              <EmbeddedSurface>
                <PlaygroundsView />
              </EmbeddedSurface>
            </TabsContent>
            <TabsContent value="experiments" className="mt-0">
              <EmbeddedSurface>
                <ExperimentsView />
              </EmbeddedSurface>
            </TabsContent>
            <TabsContent value="labeling" className="mt-0">
              <EmbeddedSurface>
                <LabelingView />
              </EmbeddedSurface>
            </TabsContent>
            <TabsContent value="studio" className="mt-0">
              <EmbeddedSurface>
                <StudioView />
              </EmbeddedSurface>
            </TabsContent>
            <TabsContent value="synthetic" className="mt-0">
              <EmbeddedSurface>
                <SyntheticView />
              </EmbeddedSurface>
            </TabsContent>
          </>
        }
      />
    </Tabs>
  );
}

export default function EvalsPage() {
  return (
    <Suspense fallback={<TabLoading />}>
      <EvalsInner />
    </Suspense>
  );
}
