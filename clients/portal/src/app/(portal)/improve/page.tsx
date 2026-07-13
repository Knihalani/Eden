"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Clock, Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import {
  improveApi,
  type ImproveQueueItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";

const COLUMNS: Array<{ id: string; label: string; hint: string }> = [
  { id: "urgent", label: "Urgent", hint: "P0 / critical issues" },
  { id: "needs_you", label: "Needs you", hint: "PR merge, approvals, credentials" },
  { id: "autonomous", label: "Eden fixing", hint: "Heal / canary / rollback in flight" },
  { id: "proposed", label: "Proposed", hint: "Closed-loop recommendations" },
  { id: "verify", label: "Verify", hint: "Approved patches awaiting check" },
];

function severityClass(sev: string): string {
  const s = sev.toLowerCase();
  if (s === "critical" || s === "high") return "text-[var(--danger)]";
  if (s === "medium") return "text-[var(--warning)]";
  return "text-[var(--text-muted)]";
}

export default function ImprovePage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [items, setItems] = useState<ImproveQueueItem[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const res = await improveApi.queue(currentOrg.id);
      const data = res.data;
      setItems(data?.items ?? []);
      setRefreshedAt(data?.refreshed_at ?? null);
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load improvement queue"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void load();
  }, [load]);

  const byColumn = useMemo(() => {
    const map: Record<string, ImproveQueueItem[]> = {};
    for (const col of COLUMNS) map[col.id] = [];
    for (const item of items) {
      const key = COLUMNS.some((c) => c.id === item.column)
        ? item.column
        : "needs_you";
      map[key].push(item);
    }
    return map;
  }, [items]);

  const onApprove = async (item: ImproveQueueItem) => {
    if (!currentOrg) return;
    setBusyRef(item.ref);
    try {
      await improveApi.approve(currentOrg.id, item.ref);
      toast.success("Approved");
      await load();
    } catch (e) {
      toast.error(errorFromCaught(e, "Approve failed"));
    } finally {
      setBusyRef(null);
    }
  };

  const onSnooze = async (item: ImproveQueueItem) => {
    if (!currentOrg) return;
    setBusyRef(item.ref);
    try {
      await improveApi.snooze(currentOrg.id, item.ref, 24);
      toast.success("Snoozed 24h");
      await load();
    } catch (e) {
      toast.error(errorFromCaught(e, "Snooze failed"));
    } finally {
      setBusyRef(null);
    }
  };

  if (!currentOrg) return <NoOrgState feature="Improve" />;

  return (
    <>
      <PageHeader
        title="Improve"
        description="One queue for triage, patches, nudges, and promotions from Agent Issues. When Eden proposes a fix, it lands here."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh improvement queue"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
        }
      />
      <PageContent>
        {error && (
          <p className="mb-4 text-sm text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
        {refreshedAt && (
          <p className="mb-4 text-xs text-[var(--text-muted)]">
            Updated {new Date(refreshedAt).toLocaleString()}
          </p>
        )}
        {loading && items.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading queue…
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing in the queue"
            description="When Eden detects issues or proposes patches and nudges, they show up here — operator and autonomous columns."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Link href="/onboarding/install">
                  <Button>Install SDK</Button>
                </Link>
                <Link href="/issues">
                  <Button variant="outline">View Agent Issues</Button>
                </Link>
              </div>
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            {COLUMNS.map((col) => (
              <section
                key={col.id}
                aria-label={col.label}
                className="min-h-[12rem] rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3"
              >
                <header className="mb-3">
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                    {col.label}
                    <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                      {byColumn[col.id]?.length ?? 0}
                    </span>
                  </h2>
                  <p className="text-xs text-[var(--text-muted)]">{col.hint}</p>
                </header>
                <ul className="space-y-2">
                  {(byColumn[col.id] ?? []).map((item) => (
                    <li
                      key={item.ref}
                      className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          {item.href ? (
                            <Link
                              href={item.href}
                              className="block truncate text-sm font-medium text-[var(--text-primary)] hover:underline"
                            >
                              {item.title}
                            </Link>
                          ) : (
                            <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                              {item.title}
                            </p>
                          )}
                          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                            <span className={severityClass(item.severity)}>
                              {item.severity}
                            </span>
                            {" · "}
                            {item.item_type}
                            {item.source ? ` · ${item.source}` : ""}
                          </p>
                          {item.blocked_reason && (
                            <p className="mt-1 text-[11px] text-[var(--warning)]">
                              Blocked: {item.blocked_reason}
                            </p>
                          )}
                          {item.autonomy_tier_required && (
                            <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                              Tier {item.autonomy_tier_required} required
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex gap-1">
                        {(item.column === "proposed" ||
                          item.column === "needs_you") &&
                          (item.ref.startsWith("closed_loop:") ||
                            item.ref.startsWith("promotion:") ||
                            item.item_type === "nudge_shadow") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              disabled={busyRef === item.ref}
                              onClick={() => void onApprove(item)}
                            >
                              <Check className="mr-1 h-3 w-3" />
                              Approve
                            </Button>
                          )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={busyRef === item.ref}
                          onClick={() => void onSnooze(item)}
                        >
                          <Clock className="mr-1 h-3 w-3" />
                          Snooze
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </PageContent>
    </>
  );
}
