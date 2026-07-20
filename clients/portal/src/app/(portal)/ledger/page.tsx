"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BookOpen, ChevronDown, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { learnApi } from "@/lib/api";
import { artifactHref, promotionsHref } from "@/lib/portal-cross-links";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { errorFromCaught } from "@/lib/safe-error-message";
import { cn } from "@/lib/utils";

type LedgerRow = { agent_id?: string; version?: number; inject_enabled?: boolean };

export default function LedgerPickerPage() {
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
        // Kill-switch / misconfig — not an opt-in wall.
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

  if (!currentOrg) {
    return <NoOrgState feature="Ledger" icon={BookOpen} />;
  }

  return (
    <CoreResourcePage
      header={
        <PageHeader
          title="Ledger"
          description="Proven Artifacts and resolved issues write the Ledger — compounding memory for your agents."
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="min-h-11" aria-label="Ledger path links">
                  More
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                <DropdownMenuLabel>Go to</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link href={artifactHref()}>Artifacts</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={promotionsHref()}>Promotions</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/improve">Improve</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      }
      table={
        error ? (
          <ErrorState
            title="Could not load ledgers"
            message={error}
            action={
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        ) : disabledMsg ? (
          <EmptyState
            variant="plain"
            title="Ledger unavailable"
            description={disabledMsg}
          />
        ) : loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-[var(--text-muted)]" aria-busy="true">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading ledgers…
          </div>
        ) : ledgers.length === 0 ? (
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
        ) : (
          <>
            <ul className="divide-y divide-[var(--border-subtle)]">
              {ledgers.map((l) => (
                <li key={String(l.agent_id)}>
                  <Link
                    href={`/agents/${encodeURIComponent(String(l.agent_id))}/ledger`}
                    className={cn(
                      "flex flex-col gap-0.5 px-1 py-3.5 transition-colors hover:bg-[var(--bg-secondary)] rounded-lg",
                    )}
                  >
                    <span className="font-medium text-[var(--text-primary)] hover:underline">
                      {l.agent_id}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
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
        )
      }
    />
  );
}
