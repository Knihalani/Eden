"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { BookOpen, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { CoreResourcePage } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrg } from "@/hooks/use-org";
import { useQueryTab } from "@/hooks/use-query-tab";
import { learnApi } from "@/lib/api";
import { artifactHref } from "@/lib/portal-cross-links";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { errorFromCaught } from "@/lib/safe-error-message";
import { cn } from "@/lib/utils";

type LedgerRow = { agent_id?: string; version?: number; inject_enabled?: boolean };

const LEDGER_TABS = ["agents", "promotions"] as const;

const PromotionsView = dynamic(() => import("@/app/(portal)/promotions/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-48 items-center justify-center" aria-busy="true">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  ),
});

function LedgerAgentsTable() {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [ledgers, setLedgers] = useState<LedgerRow[]>([]);
  const [disabledMsg, setDisabledMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setDisabledMsg(null);
    setError(null);
    try {
      const res = await learnApi.listLedgers(currentOrg.id);
      if (res.status === "preview_disabled") {
        setDisabledMsg(
          (res.data as { message?: string } | undefined)?.message ??
            "Ledger is disabled for this organization.",
        );
        setLedgers([]);
      } else {
        setLedgers((res.data?.ledgers as LedgerRow[]) ?? []);
      }
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load ledgers"));
      setLedgers([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <ErrorState
        title="Could not load ledgers"
        message={error}
        action={
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (disabledMsg) {
    return (
      <EmptyState
        variant="plain"
        title="Ledger unavailable"
        description={disabledMsg}
      />
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-[var(--text-muted)]" aria-busy="true">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading ledgers…
      </div>
    );
  }
  if (ledgers.length === 0) {
    return (
      <EmptyState
        variant="plain"
        icon={BookOpen}
        title="No ledgers yet"
        description={U20_EMPTY_COPY.ledger}
        action={
          <Button variant="outline" size="sm" asChild>
            <Link href="/artifacts">Browse artifacts</Link>
          </Button>
        }
      />
    );
  }
  return (
    <>
      <ul className="divide-y divide-[var(--border-subtle)]" data-testid="ledger-agents-list">
        {ledgers.map((l) => (
          <li key={String(l.agent_id)}>
            <Link
              href={`/agents/${encodeURIComponent(String(l.agent_id))}/ledger`}
              className={cn(
                "flex items-center justify-between gap-3 px-1 py-2.5 transition-colors hover:bg-[var(--bg-secondary)] rounded-md",
              )}
            >
              <span className="font-medium text-sm text-[var(--text-primary)] hover:underline">
                {l.agent_id}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
                v{l.version} · inject {l.inject_enabled ? "on" : "off"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {ledgers.length >= 100 ? (
        <p className="pt-3 text-center text-xs text-[var(--text-muted)]">
          Showing first 100 ledgers.
        </p>
      ) : null}
    </>
  );
}

function LedgerPickerInner() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useQueryTab("tab", LEDGER_TABS, "agents");

  if (!currentOrg) {
    return <NoOrgState feature="Ledger" icon={BookOpen} />;
  }

  return (
    <div data-wave4-improve-ledger="completed">
      <Tabs value={tab} onValueChange={(v) => setTab(v as (typeof LEDGER_TABS)[number])}>
        <CoreResourcePage
          header={
            <PageHeader
              title="Ledger"
              description="Proven Artifacts and resolved issues — compounding memory. Promotions are a mode here."
              actions={
                <nav
                  data-testid="ledger-related-strip"
                  aria-label="Related"
                  className="flex flex-wrap items-center gap-x-space-3 gap-y-1 text-xs text-[var(--text-muted)]"
                >
                  <Link href="/issues" className="text-[var(--accent)] hover:underline">
                    Issues
                  </Link>
                  <Link href="/improve" className="text-[var(--accent)] hover:underline">
                    Queue
                  </Link>
                  <Link href={artifactHref()} className="text-[var(--accent)] hover:underline">
                    Artifacts
                  </Link>
                  <Link href="/prompts" className="text-[var(--accent)] hover:underline">
                    Prompts
                  </Link>
                </nav>
              }
            />
          }
          toolbar={
            <TabsList
              variant="underline"
              aria-label="Ledger modes"
              className="h-auto w-full justify-start"
              data-testid="ledger-mode-tabs"
            >
              <TabsTrigger value="agents" variant="underline" className="min-h-11">
                Agents
              </TabsTrigger>
              <TabsTrigger
                value="promotions"
                variant="underline"
                className="min-h-11"
                data-testid="ledger-mode-promotions"
              >
                Promotions
              </TabsTrigger>
            </TabsList>
          }
          table={
            <>
              <TabsContent value="agents" className="mt-0">
                <LedgerAgentsTable />
              </TabsContent>
              <TabsContent value="promotions" className="mt-0">
                <EmbeddedSurface>
                  <PromotionsView />
                </EmbeddedSurface>
              </TabsContent>
            </>
          }
        />
      </Tabs>
    </div>
  );
}

export default function LedgerPickerPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center" aria-busy="true">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <LedgerPickerInner />
    </Suspense>
  );
}
