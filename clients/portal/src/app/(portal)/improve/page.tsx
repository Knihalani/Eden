"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NoOrgState } from "@/components/ui/no-org-state";
import { cn } from "@/lib/utils";
import {
  IMPROVE_TABS,
  ImproveRelatedStrip,
  QueueBoard,
  useImproveQueue,
} from "./_components";

/** V2 Wave 7 + V1 Wave 8 exit — Issue→Artifact→Promote ≤5 clicks; honor ?issue=. */
const WAVE7_IMPROVE_COMPLETED = true as const;
const WAVE8_IMPROVE_COMPLETED = true as const;

const PlansView = dynamic(() => import("./plans/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const HistoryView = dynamic(() => import("./runs/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});

function TabLoading() {
  return (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

export default function ImprovePage() {
  return (
    <Suspense fallback={<TabLoading />}>
      <ImprovePageInner />
    </Suspense>
  );
}

function ImprovePageInner() {
  const q = useImproveQueue();

  if (!q.currentOrg && !q.authError) return <NoOrgState feature="Improve" />;
  if (!q.currentOrg) return null;

  return (
    <Tabs
      value={q.tab}
      onValueChange={(v) => q.setTab(v as (typeof IMPROVE_TABS)[number])}
    >
      <CoreResourcePage
        size="wide"
        header={
          <PageHeader
            title="Improve"
            subtitle="Action queue, improvement plans, and sweep history."
            description="Needs traces and Agent Issues first. One queue for triage, patches, nudges, and promotions."
            actions={
              q.tab === "queue" ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => void q.load()}
                  disabled={q.loading}
                  aria-label="Refresh improvement queue"
                >
                  <RefreshCw className={cn("h-4 w-4", q.loading && "animate-spin")} />
                  Refresh
                </Button>
              ) : undefined
            }
          />
        }
        toolbar={
          <div
            data-testid="improve-toolbar"
            data-wave1-improve="completed"
            data-wave2-improve-queue="completed"
            data-wave7-improve="completed"
            data-wave8-improve="completed"
            data-wave9-improve-crossloop="completed"
            data-wave10-improve-verify="completed"
            className="flex flex-col gap-space-2 border-b border-[var(--border-subtle)] pb-space-1"
          >
            <TabsList
              variant="underline"
              aria-label="Improve sections"
              className="h-auto min-w-0 w-full justify-start gap-space-1 overflow-x-auto bg-transparent"
            >
              {IMPROVE_TABS.map((t) => {
                const label =
                  t === "queue" ? "Queue" : t === "plans" ? "Plans" : "History";
                return (
                  <TabsTrigger
                    key={t}
                    variant="underline"
                    value={t}
                    title={label}
                    className="min-h-11 shrink-0 capitalize"
                  >
                    {label}
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <ImproveRelatedStrip />
          </div>
        }
        table={
          <>
            <TabsContent value="plans" className="mt-0">
              <EmbeddedSurface>
                <PlansView />
              </EmbeddedSurface>
            </TabsContent>
            <TabsContent value="history" className="mt-0">
              <EmbeddedSurface>
                <HistoryView />
              </EmbeddedSurface>
            </TabsContent>
            <TabsContent value="queue" className="mt-0">
              <QueueBoard q={q} />
            </TabsContent>
          </>
        }
      />
    </Tabs>
  );
}
