"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, Suspense } from "react";
import { ChevronDown, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { learnApi } from "@/lib/api";
import {
  CoreResourcePage,
  DetailPanelShell,
  useResourceUrlState,
  ResourceOsToolbar,
  BulkActionBar,
} from "@/components/portal-os";
import { cn } from "@/lib/utils";
import { artifactHref } from "@/lib/portal-cross-links";
import { errorFromCaught } from "@/lib/safe-error-message";

type PromoRow = Record<string, unknown> & {
  id?: string;
  kind?: string;
  ref_id?: string;
  status?: string;
  evidence?: Record<string, unknown>;
};

function EvidenceGateSummary({
  evidence,
  report,
}: {
  evidence?: Record<string, unknown>;
  report?: Record<string, unknown> | null;
}) {
  const src = report ?? evidence ?? {};
  const metrics = (src.metrics as Record<string, unknown> | undefined) ?? src;
  const nControl = Number(metrics.n_control ?? src.n ?? src.sample_count ?? 0);
  const nTreatment = Number(metrics.n_treatment ?? 0);
  const n = Math.min(nControl || Number(src.n ?? 0), nTreatment || Number(src.n ?? 0)) || Number(src.n ?? src.sample_count ?? 0);
  const minN = Number(src.min_n ?? metrics.min_n ?? src.min_sample_size ?? 50);
  const passed = Boolean(src.passed ?? src.gate_pass);
  const verdict = String(src.gate_verdict ?? src.recommendation ?? (passed ? "PROMOTE" : "HOLD"));
  const pct = minN > 0 ? Math.min(100, (n / minN) * 100) : 0;
  const explanation = src.explanation != null ? String(src.explanation) : null;
  const bayes = metrics.prob_treatment_better != null ? Number(metrics.prob_treatment_better) : null;
  const bayesAdvisory = Boolean(metrics.bayesian_advisory_only);
  const respectsMinN = metrics.bayesian_respects_min_n !== false;

  return (
    <div className="space-y-3 text-sm" data-testid="evidence-gate">
      <p className="text-xs font-medium text-[var(--text-secondary)]">EvidenceGate</p>
      <div>
        <div className="mb-1 flex justify-between text-xs text-[var(--text-muted)]">
          <span>Min samples (honest floor)</span>
          <span>
            {n}/{minN}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
          <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <dl className="grid gap-2 text-xs">
        <div className="flex justify-between gap-4">
          <dt className="text-[var(--text-muted)]">Verdict</dt>
          <dd className="font-medium">{verdict}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-[var(--text-muted)]">Gate</dt>
          <dd>{passed ? "READY" : n >= minN ? "REVIEW" : "COLLECTING"}</dd>
        </div>
        {bayes != null ? (
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--text-muted)]">
              Bayesian P(better){bayesAdvisory ? " (advisory)" : ""}
            </dt>
            <dd>{(bayes * 100).toFixed(1)}%</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-4">
          <dt className="text-[var(--text-muted)]">min_n binding</dt>
          <dd>{respectsMinN ? "required" : "advisory"}</dd>
        </div>
      </dl>
      {explanation ? <p className="text-xs text-[var(--text-muted)]">{explanation}</p> : null}
      {!passed && n < minN ? (
        <p className="text-xs text-[var(--text-muted)]" data-testid="min-n-hold">
          Promote blocked under min_n — need {minN} samples per arm.
        </p>
      ) : null}
    </div>
  );
}

function PromotionsPageInner() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const promotionId = urlState.promotionId;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<PromoRow[]>([]);
  const [tab, setTab] = useState("shadow");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailReport, setDetailReport] = useState<Record<string, unknown> | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const res = await learnApi.listPromotions(currentOrg.id, tab === "all" ? undefined : tab);
      setItems((res.data?.promotions as PromoRow[]) ?? []);
      setSelected(new Set());
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load promotions"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!currentOrg || !promotionId) {
      setDetailReport(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await learnApi.getPromotion(currentOrg.id, promotionId);
        if (!cancelled) {
          setDetailReport(
            (res.data?.report as Record<string, unknown>) ??
              (res.data?.candidate as Record<string, unknown>) ??
              null,
          );
        }
      } catch {
        if (!cancelled) setDetailReport(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg, promotionId]);

  const act = async (id: string, action: "approve" | "reject") => {
    if (!currentOrg) return;
    try {
      if (action === "approve") {
        const res = await learnApi.approvePromotion(currentOrg.id, id);
        const report = res.data?.report as Record<string, unknown> | undefined;
        if (report?.passed) {
          toast.success("Promotion approved");
        } else {
          const held = String(
            report?.explanation ||
              report?.recommendation ||
              report?.gate_verdict ||
              "hold",
          );
          toast.error(`Promotion held: ${held}`);
        }
      } else {
        const res = await learnApi.rejectPromotion(currentOrg.id, id);
        if (res.data?.rejected) {
          toast.success("Promotion rejected");
        } else {
          toast.error("Rejection failed");
        }
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${action} failed`);
    }
  };

  const bulkApprove = async () => {
    if (!currentOrg || selected.size === 0) return;
    setBulkBusy(true);
    let ok = 0;
    for (const id of selected) {
      try {
        const res = await learnApi.approvePromotion(currentOrg.id, id);
        if (res.data?.report && (res.data.report as Record<string, unknown>).passed) {
          ok += 1;
        }
      } catch {
        /* continue */
      }
    }
    setBulkBusy(false);
    if (ok === 0) {
      toast.error(`Approved 0/${selected.size}`);
    } else {
      toast.success(`Approved ${ok}/${selected.size}`);
    }
    await load();
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!currentOrg) return <NoOrgState feature="Promotions" />;

  const selectedRow = promotionId
    ? (items.find((p) => String(p.id) === promotionId) ?? null)
    : null;
  const selectedIndex = promotionId
    ? items.findIndex((p) => String(p.id) === promotionId)
    : -1;

  return (
    <CoreResourcePage
      header={
        <PageHeader
          title="Promotions inbox"
          description="Evidence-gated candidates — shadow, pending review, promoted, demoted."
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="min-h-11" aria-label="Promotions path links">
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
                  <Link href="/improve">Improve</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/issues">Issues</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      }
      toolbar={
        <div className="space-y-space-3" data-testid="promotions-toolbar">
          <div className="flex flex-wrap gap-space-1">
            {["shadow", "promoted", "demoted", "all"].map((s) => (
              <Button
                key={s}
                size="sm"
                variant={tab === s ? "default" : "ghost"}
                onClick={() => {
                  setTab(s);
                  setUrlState({ promotionId: undefined });
                }}
              >
                {s}
              </Button>
            ))}
          </div>
          <ResourceOsToolbar
            resourceKey="promotions"
            exportRows={items.map((p) => ({
              id: String(p.id ?? ""),
              kind: String(p.kind ?? ""),
              status: String(p.status ?? ""),
              ref_id: String(p.ref_id ?? ""),
            }))}
            exportFilename="promotions.csv"
          />
        </div>
      }
      table={
        error ? (
          <ErrorState
            message={error}
            action={
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        ) : loading ? (
          <Loader2 className="h-8 w-8 animate-spin" />
        ) : items.length === 0 ? (
          <EmptyState
            variant="plain"
            title="No promotions"
            description="Shadow Artifacts appear here after detectors or manual create."
          />
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {items.map((p) => {
              const id = String(p.id);
              const active = promotionId === id;
              return (
                <div
                  key={id}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 px-1 py-3.5 transition-colors rounded-lg",
                    active ? "bg-[var(--accent-faint)]/40 ring-1 ring-[var(--accent)]/30" : "hover:bg-[var(--bg-secondary)]",
                  )}
                  onClick={() => setUrlState({ promotionId: active ? undefined : id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setUrlState({ promotionId: active ? undefined : id });
                    }
                  }}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {tab === "shadow" ? (
                      <div onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected.has(id)}
                          onCheckedChange={() => toggleSelect(id)}
                          aria-label={`Select ${id}`}
                        />
                      </div>
                    ) : null}
                    <div className="min-w-0">
                      <div className="font-medium">
                        {String(p.kind)} · {String(p.ref_id)}
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">{String(p.status)}</div>
                    </div>
                  </div>
                  {tab === "shadow" ? (
                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" onClick={() => void act(id, "approve")}>
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void act(id, "reject")}>
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Link href={`/artifacts?ref=${encodeURIComponent(String(p.ref_id))}`}>
                        View
                      </Link>
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )
      }
      bulkBar={
        selected.size > 0 ? (
          <BulkActionBar
            count={selected.size}
            onClear={() => setSelected(new Set())}
            actions={[
              {
                label: bulkBusy ? "Approving…" : "Bulk approve",
                onClick: () => {
                  if (!bulkBusy) void bulkApprove();
                },
              },
            ]}
          />
        ) : null
      }
      detail={
        promotionId && selectedRow ? (
          <DetailPanelShell
            open
            onClose={() => setUrlState({ promotionId: undefined })}
            title={`${String(selectedRow.kind)} · ${String(selectedRow.ref_id)}`}
            onPrev={
              selectedIndex > 0
                ? () => setUrlState({ promotionId: String(items[selectedIndex - 1]?.id) })
                : undefined
            }
            onNext={
              selectedIndex >= 0 && selectedIndex < items.length - 1
                ? () => setUrlState({ promotionId: String(items[selectedIndex + 1]?.id) })
                : undefined
            }
            headerActions={
              tab === "shadow" ? (
                <div className="flex gap-1">
                  <Button size="sm" onClick={() => void act(String(selectedRow.id), "approve")}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void act(String(selectedRow.id), "reject")}
                  >
                    Reject
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" asChild>
                  <Link
                    href={`/artifacts?ref=${encodeURIComponent(String(selectedRow.ref_id))}`}
                  >
                    View artifact
                  </Link>
                </Button>
              )
            }
          >
            <div className="space-y-4 p-4 text-sm">
              <dl className="grid gap-2 text-xs">
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--text-muted)]">Kind</dt>
                  <dd>{String(selectedRow.kind)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--text-muted)]">Ref</dt>
                  <dd className="truncate font-mono">{String(selectedRow.ref_id)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--text-muted)]">Status</dt>
                  <dd>{String(selectedRow.status)}</dd>
                </div>
              </dl>
              <EvidenceGateSummary
                evidence={selectedRow.evidence}
                report={detailReport}
              />
            </div>
          </DetailPanelShell>
        ) : null
      }
    />
  );
}

export default function PromotionsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <PromotionsPageInner />
    </Suspense>
  );
}
