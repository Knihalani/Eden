"use client";

import { useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sparkles, FileText, Layers, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TemplatesTab } from "./_components/templates-tab";
import { FromExamplesTab } from "./_components/from-examples-tab";
import { MyMetricsTab } from "./_components/my-metrics-tab";
import {
  type StudioTab,
  type TemplateSeed,
} from "./_components/studio-helpers";

const WAVE_E5_STUDIO_COMPLETED = true;

export default function StudioPage() {
  const { currentOrg } = useOrg();
  const embedded = useEmbeddedSurface();
  const [activeTab, setActiveTab] = useState<StudioTab>("templates");
  const [error, setError] = useState("");
  const [examplesDirty, setExamplesDirty] = useState(false);
  const [templateSeed, setTemplateSeed] = useState<TemplateSeed | null>(null);

  const requestTabChange = useCallback(
    (next: StudioTab) => {
      if (next === activeTab) return;
      if (activeTab === "examples" && examplesDirty) {
        const leave = window.confirm(
          "You have unsaved rubric work. Leave this tab?",
        );
        if (!leave) return;
      }
      setError("");
      setActiveTab(next);
    },
    [activeTab, examplesDirty],
  );

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Eval"
        title="Custom-Metric Studio"
        subtitle="Build rubrics from templates or examples."
        icon={Sparkles}
        embedded={embedded}
      />

      <div
        data-wave-e1-embed="studio"
        data-wave-e5-studio="shell"
        className="contents"
      >
      {error ? (
        <ErrorState
          title="Something went wrong"
          message={error}
          action={
            <Button
              type="button"
              variant="outline"
              className="h-8 max-md:min-h-11"
              onClick={() => setError("")}
            >
              Dismiss
            </Button>
          }
        />
      ) : null}

      {!currentOrg ? (
        <NoOrgState
          icon={Sparkles}
          feature="Custom-Metric Studio"
          description="Choose an organization to design and version custom evaluation rubrics."
        />
      ) : (
        <>
          <Tabs
            value={activeTab}
            onValueChange={(v) => requestTabChange(v as StudioTab)}
          >
            <TabsList
              variant="underline"
              aria-label="Custom-Metric Studio sections"
              className="mb-space-3 h-auto w-full justify-start gap-1 overflow-x-auto border-b border-[var(--border-subtle)] bg-transparent"
            >
              {(
                [
                  { key: "templates" as StudioTab, label: "Templates", icon: FileText },
                  { key: "examples" as StudioTab, label: "From examples", icon: Wand2 },
                  { key: "metrics" as StudioTab, label: "My metrics", icon: Layers },
                ] as const
              ).map(({ key, label, icon: Icon }) => (
                <TabsTrigger
                  key={key}
                  variant="underline"
                  value={key}
                  className="h-8 max-md:min-h-11 shrink-0"
                >
                  <Icon className="mr-1.5 hidden h-4 w-4 sm:inline" aria-hidden />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>

            {activeTab === "templates" && (
              <TemplatesTab
                orgId={currentOrg.id}
                onUseTemplate={(seed) => {
                  setTemplateSeed(seed);
                  setActiveTab("examples");
                  setError("");
                }}
              />
            )}
            {activeTab === "examples" && (
              <FromExamplesTab
                orgId={currentOrg.id}
                onError={setError}
                onDirtyChange={setExamplesDirty}
                templateSeed={templateSeed}
                onTemplateSeedConsumed={() => setTemplateSeed(null)}
              />
            )}
            {activeTab === "metrics" && <MyMetricsTab orgId={currentOrg.id} onError={setError} />}
          </Tabs>
        </>
      )}
      </div>
    </PageContent>
  );
}
