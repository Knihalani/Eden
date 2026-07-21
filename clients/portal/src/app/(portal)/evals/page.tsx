"use client";

/**
 * /evals — Dataset → playground → experiment (Evaluate V3 / Wave E1).
 * Three primary tabs; Advanced tools live in overflow and embed their surfaces.
 */

import { Suspense } from "react";
import dynamic from "next/dynamic";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQueryTab } from "@/hooks/use-query-tab";
import { usePagePerf } from "@/lib/perf";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  WAVE_E6_KEYBOARD_COMPLETED,
  WAVE_E6_MOBILE_COMPLETED,
  WAVE_E6_PERF_COMPLETED,
  WAVE_E6_AXE_CONTRACT_COMPLETED,
  WAVE_E6_E2E_CONTRACT_COMPLETED,
  WAVE_E6_LOC_RATCHET_COMPLETED,
} from "./_components/wave-e6-flags";

void WAVE_E6_KEYBOARD_COMPLETED;
void WAVE_E6_MOBILE_COMPLETED;
void WAVE_E6_PERF_COMPLETED;
void WAVE_E6_AXE_CONTRACT_COMPLETED;
void WAVE_E6_E2E_CONTRACT_COMPLETED;
void WAVE_E6_LOC_RATCHET_COMPLETED;

/** Wave 8 exit marker — Evaluate hub: 3 tabs + Advanced leaves + Trace deep links. */
const WAVE8_EVALS_COMPLETED = true as const;

/** Wave E1 — IA truth + Observe→Eval closed loop. */
const WAVE_E1_IA_COMPLETED = true as const;
const WAVE_E1_CLOSED_LOOP_COMPLETED = true as const;

/** Wave E5 — Advanced leaves (Scores / Labeling / Studio / Synthetic). */
const WAVE_E5_ADVANCED_COMPLETED = true as const;
const WAVE_E5_HUB_MENU_COMPLETED = true as const;

/** First-run path objects (E-01 / E-12). */
const PRIMARY_TABS = ["datasets", "playgrounds", "experiments"] as const;

/** Scores / labeling / studio / synthetic — disclosure overflow. */
const ADVANCED_TABS = ["eval", "labeling", "studio", "synthetic"] as const;

const TABS = [...PRIMARY_TABS, ...ADVANCED_TABS] as const;

type EvalTab = (typeof TABS)[number];

const TAB_META: Record<
  EvalTab,
  { label: string; title: string; hint: string; job?: string }
> = {
  datasets: {
    label: "Datasets",
    title: "Golden sets and cases to score against",
    hint: "Curate cases — add from Traces, then open Playground.",
  },
  playgrounds: {
    label: "Playground",
    title: "Side-by-side prompt runs before an experiment",
    hint: "Mutable iterate — bind a dataset, then Promote → Experiment.",
  },
  experiments: {
    label: "Experiments",
    title: "Offline eval runs over a bound dataset",
    hint: "Immutable compare — multi-select two runs for deltas.",
  },
  eval: {
    label: "Scores",
    title: "Judge versions and failure clusters from scored traces",
    hint: "Tag judge versions and browse failure clusters. Production online scoring lives under Improve.",
    job: "Versions + failure clusters",
  },
  labeling: {
    label: "Labeling",
    title: "Human labels that feed datasets",
    hint: "Annotate items, then push done labels into a dataset.",
    job: "Human labels → datasets",
  },
  studio: {
    label: "Studio",
    title: "Custom metric rubrics (advanced)",
    hint: "Design rubrics from templates or examples.",
    job: "Custom metric rubrics",
  },
  synthetic: {
    label: "Synthetic",
    title: "Synthetic QA cases for datasets (advanced)",
    hint: "Generate extractive Q/A triples. Persisted run history is deferred.",
    job: "Generate Q/A triples",
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

function isAdvancedTab(tab: EvalTab): boolean {
  return (ADVANCED_TABS as readonly string[]).includes(tab);
}

function EvalsInner() {
  usePagePerf("/evals");
  const [tab, setTab] = useQueryTab("tab", TABS, "datasets");
  const advancedActive = isAdvancedTab(tab);

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as EvalTab)}
      data-wave11-mobile="cards"
      data-wave-e6-perf="evals"
    >
      <CoreResourcePage
        size="wide"
        header={
          <PageHeader
            title="Evals"
            subtitle="Traces → dataset → playground → experiment. Studio/synthetic are live — not stubs."
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
            data-wave8-evals="completed"
            data-wave-e1-evals="ia"
            data-wave-e1-closed-loop="path"
            data-wave-e5-evals="advanced"
            data-wave-e6-evals="harden"
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
                  data-wave-e1-tab={t}
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
                  aria-label="Advanced eval tools"
                  aria-current={advancedActive ? "page" : undefined}
                  data-testid="evals-advanced"
                  data-wave-e1-advanced="overflow"
                >
                  <span className="hidden sm:inline">
                    {advancedActive ? `Advanced · ${TAB_META[tab].label}` : "Advanced"}
                  </span>
                  <span className="sm:hidden">More</span>
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[14rem]"
                data-wave-e5-advanced="menu"
                data-testid="evals-advanced-menu"
              >
                <DropdownMenuLabel>Advanced</DropdownMenuLabel>
                {ADVANCED_TABS.map((t) => (
                  <DropdownMenuItem
                    key={t}
                    onSelect={() => setTab(t)}
                    title={TAB_META[t].title}
                    className={cn(
                      "flex flex-col items-start gap-1 py-2",
                      tab === t && "bg-[var(--accent-bg)] text-[var(--accent)]",
                    )}
                    data-wave-e5-advanced={t}
                  >
                    <span className="font-medium">{TAB_META[t].label}</span>
                    {TAB_META[t].job ? (
                      <span className="text-[length:var(--font-size-2xs)] font-normal text-[var(--text-muted)]">
                        {TAB_META[t].job}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
        table={
          <>
            <p
              className="mb-space-4 text-sm text-[var(--text-muted)]"
              data-wave-e1-path-hint={tab}
            >
              {TAB_META[tab].hint}
            </p>

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
