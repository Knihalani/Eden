"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { BookMarked } from "lucide-react";
import { learnApi } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LedgerEntryDetail,
  LedgerTimeline,
  normalizeLedgerEntries,
} from "@/components/improve";
import { useImproveUrlState } from "../_hooks/use-improve-url-state";

export type LedgerTabProps = {
  /** When set, agent filter is locked (agent child page). */
  lockedAgentId?: string;
};

function useIsXl() {
  const [isXl, setIsXl] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const apply = () => setIsXl(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return isXl;
}

export function LedgerTab({ lockedAgentId }: LedgerTabProps) {
  const t = useTranslations("improve");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { state, setState, clearSelection } = useImproveUrlState();
  const isXl = useIsXl();
  const agentId = lockedAgentId ?? state.agentId;

  const listQuery = useOrgQuery(
    ["improve", "ledger", orgId, agentId ?? "all"] as const,
    orgId,
    async () => {
      if (agentId) {
        return learnApi.getLedger(orgId!, agentId);
      }
      return learnApi.listLedgers(orgId!);
    },
  );

  const rows = useMemo(() => {
    const payload = listQuery.data?.data;
    if (!payload) return [];
    if (agentId) {
      return normalizeLedgerEntries(payload, agentId);
    }
    return normalizeLedgerEntries(payload);
  }, [listQuery.data, agentId]);

  const filtered = useMemo(() => {
    const q = (state.q ?? "").trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        r.kind.toLowerCase().includes(q) ||
        (r.agentId ?? "").toLowerCase().includes(q),
    );
  }, [rows, state.q]);

  const selected =
    filtered.find((r) => r.id === state.entryId) ??
    rows.find((r) => r.id === state.entryId) ??
    null;

  const detailOpen = Boolean(state.entryId);

  return (
    <div data-testid="improve-ledger-tab">
      <ResourcePageShell
        table={
          <QueryState
            loading={listQuery.isLoading}
            error={listQuery.error}
            data={filtered}
            onRetry={() => void listQuery.refetch()}
            isEmpty={(r) => r.length === 0}
            filtersActive={Boolean(state.q)}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              <EmptyState
                icon={BookMarked}
                title={t("ledger.empty.title")}
                description={t("ledger.empty.body")}
                action={
                  <Button asChild size="sm" className="min-h-11">
                    <Link href="/improve?tab=queue">
                      {t("ledger.empty.cta")}
                    </Link>
                  </Button>
                }
              />
            }
            filterEmptySlot={
              <EmptyState
                title={t("ledger.filterEmpty.title")}
                description={t("ledger.filterEmpty.body")}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11"
                    onClick={() => setState({ q: undefined })}
                  >
                    {t("ledger.filterEmpty.clear")}
                  </Button>
                }
              />
            }
          >
            {(data) => (
              <LedgerTimeline
                rows={data}
                selectedId={state.entryId}
                onSelect={(id) => setState({ entryId: id })}
              />
            )}
          </QueryState>
        }
        detail={
          detailOpen && isXl && selected ? (
            <LedgerEntryDetail
              entry={selected}
              open
              onClose={clearSelection}
              mobileDrawer={false}
            />
          ) : undefined
        }
      />

      {detailOpen && !isXl && selected ? (
        <LedgerEntryDetail
          entry={selected}
          open
          onClose={clearSelection}
          mobileDrawer
        />
      ) : null}
    </div>
  );
}
