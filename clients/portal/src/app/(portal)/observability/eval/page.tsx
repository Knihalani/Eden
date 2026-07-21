"use client";

import Link from "next/link";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { PageContent } from "@/components/layout/page-content";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, Gauge, Tag, Layers, ExternalLink } from "lucide-react";
import {
  useScoresPage,
  type ScoresTab,
} from "./_components/use-scores-page";
import { VersionsPanel } from "./_components/versions-panel";
import { FailureClustersPanel } from "./_components/failure-clusters-panel";

export default function EvalPage() {
  const {
    currentOrg,
    embedded,
    activeTab,
    setActiveTab,
    error,
    setError,
  } = useScoresPage();

  return (
    <PageContent size="wide">
      <div data-wave-e5-scores="panel">
        <PageHeader
          title="Scores"
          subtitle="Judge versions and failure clusters — Advanced under Evals."
          icon={BarChart3}
          embedded={embedded}
          actions={
            <Button asChild variant="outline" className="h-8 max-md:min-h-11">
              <Link
                href="/improve/online-scoring"
                data-wave-e5-scores="improve-link"
                data-testid="scores-improve-online-scoring"
              >
                Online scoring
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </Button>
          }
        />

        <p className="mb-space-3 text-xs text-[var(--text-muted)]">
          Production online scoring rules live under Improve. This panel tracks judge
          versions and failure clusters only.
        </p>

        {error ? (
          <ErrorState
            title="Evaluation request failed"
            message={error}
            action={
              <Button size="sm" variant="outline" onClick={() => setError("")}>
                Dismiss
              </Button>
            }
          />
        ) : null}

        {!currentOrg ? (
          <NoOrgState
            icon={Gauge}
            feature="Scores"
            description="Choose an organization to manage judge versions and failure clusters."
          />
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as ScoresTab)}
          >
            <TabsList
              variant="underline"
              aria-label="Scores sections"
              className="h-auto w-full justify-start gap-1 border-b border-[var(--border-subtle)] bg-transparent"
              data-testid="scores-advanced-tabs"
            >
              {(
                [
                  { key: "versions" as ScoresTab, label: "Versions", icon: Tag },
                  {
                    key: "clusters" as ScoresTab,
                    label: "Failure clusters",
                    icon: Layers,
                  },
                ] as const
              ).map(({ key, label, icon: Icon }) => (
                <TabsTrigger
                  key={key}
                  value={key}
                  variant="underline"
                  className="flex h-8 max-md:min-h-11 items-center gap-2"
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>

            {activeTab === "versions" ? (
              <VersionsPanel orgId={currentOrg.id} onError={setError} />
            ) : null}
            {activeTab === "clusters" ? (
              <FailureClustersPanel orgId={currentOrg.id} onError={setError} />
            ) : null}
          </Tabs>
        )}
      </div>
    </PageContent>
  );
}
