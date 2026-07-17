"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BookOpen, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, CrossLinkBar } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useOrg } from "@/hooks/use-org";
import { learnApi } from "@/lib/api";
import { artifactHref, promotionsHref } from "@/lib/portal-cross-links";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";

type LedgerRow = { agent_id?: string; version?: number; inject_enabled?: boolean };

export default function LedgerPickerPage() {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [ledgers, setLedgers] = useState<LedgerRow[]>([]);
  const [disabledMsg, setDisabledMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setDisabledMsg(null);
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
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <CoreResourcePage
      header={
        <PageHeader
          title="Ledger"
          description="Proven Artifacts and resolved issues write the Ledger — compounding memory for your agents."
        />
      }
      table={
        <>
          <CrossLinkBar
            className="mb-4"
            links={[
              { label: "Artifacts", href: artifactHref() },
              { label: "Promotions", href: promotionsHref() },
              { label: "Improve", href: "/improve" },
            ]}
          />
          {disabledMsg ? (
            <EmptyState
              title="Ledger unavailable"
              description={disabledMsg}
            />
          ) : loading ? (
            <Loader2 className="h-8 w-8 animate-spin" />
          ) : ledgers.length === 0 ? (
            <EmptyState
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
            <div className="space-y-2">
              {ledgers.map((l) => (
                <Card key={String(l.agent_id)} className="p-4">
                  <Link
                    href={`/agents/${encodeURIComponent(String(l.agent_id))}/ledger`}
                    className="font-medium hover:underline"
                  >
                    {l.agent_id}
                  </Link>
                  <div className="text-xs text-[var(--text-muted)]">
                    v{l.version} · inject {l.inject_enabled ? "on" : "off"}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      }
    />
  );
}
