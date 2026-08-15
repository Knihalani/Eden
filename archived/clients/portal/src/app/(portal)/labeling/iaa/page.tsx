"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { labelingApi } from "@/lib/api/labeling";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";

/** Default agreement threshold for "needs another reviewer" (FEAT-119). */
const DEFAULT_AGREEMENT_THRESHOLD = 0.5;

function pct(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(0)}%`;
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "accent" | "terminal" | "warning";
}) {
  const toneClass =
    tone === "accent"
      ? "text-[var(--accent)]"
      : tone === "terminal"
        ? "text-[var(--terminal)]"
        : "text-[var(--warning)]";
  return (
    <div className="ds-panel flex flex-col gap-1 p-4">
      <span className="type-meta text-[var(--text-muted)]">{label}</span>
      <span className={`type-display text-2xl font-semibold ${toneClass}`}>{value}</span>
      <span className="type-meta text-[var(--text-faint)]">{hint}</span>
    </div>
  );
}

function needsAnotherReviewer(
  agreement: number | undefined,
  annotationsCount: number | undefined,
  annotationsRequired: number | undefined,
  threshold: number,
): boolean {
  if (typeof agreement !== "number" || agreement >= threshold) return false;
  const count = annotationsCount ?? 0;
  const required = annotationsRequired ?? 1;
  return count < required;
}

/**
 * `/labeling/iaa` — inter-annotator agreement dashboard (FEAT-81 / FEAT-119).
 *
 * Renders the headline kappa / alpha / overall-agreement tiles, the
 * per-annotator-pair table, and the per-item table sorted ascending by
 * agreement — plus a "needs another reviewer" filter for low-agreement items.
 */
function IaaInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const [needsReviewerOnly, setNeedsReviewerOnly] = useState(false);
  const [threshold, setThreshold] = useState(DEFAULT_AGREEMENT_THRESHOLD);
  const [escalateBusyId, setEscalateBusyId] = useState<string | null>(null);

  const agreementQuery = useOrgQuery(
    queryKeys.labeling.agreement(orgId),
    orgId,
    () => labelingApi.agreement(orgId!),
    SHELL_QUERY,
  );

  const perItemSorted = useMemo(() => {
    const perItem = agreementQuery.data?.per_item ?? {};
    return Object.entries(perItem)
      .filter(([, entry]) => typeof entry.agreement === "number")
      .map(([itemId, entry]) => ({
        itemId,
        agreement: entry.agreement as number,
        kappa: typeof entry.kappa === "number" ? entry.kappa : null,
        annotationsCount:
          typeof entry.annotations_count === "number"
            ? entry.annotations_count
            : undefined,
        annotationsRequired:
          typeof entry.annotations_required === "number"
            ? entry.annotations_required
            : undefined,
        needsReviewer: needsAnotherReviewer(
          entry.agreement,
          entry.annotations_count,
          entry.annotations_required,
          threshold,
        ),
      }))
      .filter((row) => (needsReviewerOnly ? row.needsReviewer : true))
      .sort((a, b) => a.agreement - b.agreement);
  }, [agreementQuery.data, needsReviewerOnly, threshold]);

  const needsReviewerCount = useMemo(() => {
    const perItem = agreementQuery.data?.per_item ?? {};
    return Object.values(perItem).filter((e) =>
      needsAnotherReviewer(
        e.agreement,
        e.annotations_count,
        e.annotations_required,
        threshold,
      ),
    ).length;
  }, [agreementQuery.data, threshold]);

  const perPair = useMemo(() => {
    const perPair = agreementQuery.data?.per_pair ?? {};
    return Object.entries(perPair).sort((a, b) => a[1].agreement - b[1].agreement);
  }, [agreementQuery.data]);

  const escalateItem = async (itemId: string) => {
    if (!orgId) return;
    setEscalateBusyId(itemId);
    try {
      await labelingApi.escalate(orgId, itemId);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.labeling.agreement(orgId),
      });
    } finally {
      setEscalateBusyId(null);
    }
  };

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="IAA dashboard"
        message="Select a workspace to view inter-annotator agreement."
      />
    );
  }

  if (agreementQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Inter-annotator agreement" />
        <QueryLoadingPanel label="Computing agreement…" />
      </div>
    );
  }

  if (agreementQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Inter-annotator agreement" />
        <QueryErrorPanel
          error={agreementQuery.error}
          onRetry={() => void agreementQuery.refetch()}
        />
      </div>
    );
  }

  const report = agreementQuery.data;
  const hasDualLabeled =
    (report?.annotation_count ?? 0) >= 2 &&
    Object.values(report?.per_item ?? {}).some((e) => typeof e.agreement === "number");

  const meta = (
    <span className="type-meta">
      {report?.item_count ?? 0} items · {report?.annotation_count ?? 0} annotations
      {needsReviewerCount > 0
        ? ` · ${needsReviewerCount} need another reviewer`
        : ""}
    </span>
  );

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Inter-annotator agreement"
        meta={meta}
        actions={
          <Link
            href="/labeling"
            className="ds-btn ds-btn-outline"
            aria-label="Back to labeling"
          >
            <ChevronLeft className="h-4 w-4" />
            Labeling
          </Link>
        }
      />

      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-3">
        <Tile
          label="Cohen's κ"
          value={report?.kappa != null ? report.kappa.toFixed(2) : "—"}
          hint="Chance-corrected pairwise agreement"
          tone="accent"
        />
        <Tile
          label="Krippendorff's α"
          value={report?.alpha != null ? report.alpha.toFixed(2) : "—"}
          hint="Multi-annotator reliability"
          tone="terminal"
        />
        <Tile
          label="Overall agreement"
          value={pct(report?.overall_agreement)}
          hint="Raw observed agreement across items"
          tone={hasDualLabeled ? "terminal" : "warning"}
        />

        {!hasDualLabeled ? (
          <div className="col-span-full py-10">
            <EmptyState
              title="No dual-labeled items yet"
              body="Agreement metrics appear once two annotators have labeled the same item. Label an item twice in the annotator surface, then revisit this dashboard."
            />
          </div>
        ) : (
          <>
            <section className="col-span-full">
              <h3 className="type-ui mb-2 text-[var(--text-muted)]">By annotator pair</h3>
              <div className="ds-panel overflow-x-auto">
                <table className="w-full min-w-[28rem] text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--line)] text-[var(--text-muted)]">
                      <th className="px-4 py-2 font-normal">Pair</th>
                      <th className="px-4 py-2 font-normal">κ</th>
                      <th className="px-4 py-2 font-normal">Agreement</th>
                      <th className="px-4 py-2 font-normal">Co-labeled items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perPair.map(([pair, entry]) => (
                      <tr
                        key={pair}
                        className="border-b border-[var(--line)] last:border-b-0"
                      >
                        <td className="px-4 py-2">{pair.replace("|", " ⟷ ")}</td>
                        <td className="px-4 py-2 text-[var(--text-muted)]">
                          {typeof entry.kappa === "number" ? entry.kappa.toFixed(2) : "—"}
                        </td>
                        <td className="px-4 py-2 text-[var(--text-muted)]">
                          {pct(entry.agreement)}
                        </td>
                        <td className="px-4 py-2 text-[var(--text-muted)]">{entry.n}</td>
                      </tr>
                    ))}
                    {perPair.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-4 text-[var(--text-faint)]">
                          No co-labeled pairs yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="col-span-full">
              <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
                <h3 className="type-ui text-[var(--text-muted)]">
                  By item — lowest agreement first
                </h3>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 type-meta text-[var(--text-muted)]">
                    <input
                      type="checkbox"
                      checked={needsReviewerOnly}
                      onChange={(e) => setNeedsReviewerOnly(e.target.checked)}
                      className="accent-[var(--accent)]"
                    />
                    Needs another reviewer
                    {needsReviewerCount > 0 ? ` (${needsReviewerCount})` : ""}
                  </label>
                  <label className="flex items-center gap-2 type-meta text-[var(--text-muted)]">
                    Threshold
                    <select
                      className="ds-input !h-8 !py-0 !text-sm"
                      value={String(threshold)}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                      aria-label="Agreement threshold"
                    >
                      <option value="0.3">30%</option>
                      <option value="0.5">50%</option>
                      <option value="0.7">70%</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="ds-panel overflow-x-auto">
                <table className="w-full min-w-[28rem] text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--line)] text-[var(--text-muted)]">
                      <th className="px-4 py-2 font-normal">Item</th>
                      <th className="px-4 py-2 font-normal">Agreement</th>
                      <th className="px-4 py-2 font-normal">κ</th>
                      <th className="px-4 py-2 font-normal">Reviewers</th>
                      <th className="px-4 py-2 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {perItemSorted.map((row) => (
                      <tr
                        key={row.itemId}
                        className="border-b border-[var(--line)] last:border-b-0"
                      >
                        <td className="px-4 py-2 font-mono text-xs">
                          <Link
                            href={`/labeling/annotate?item=${row.itemId}`}
                            className="text-[var(--accent)] hover:underline"
                          >
                            {row.itemId.slice(0, 12)}
                          </Link>
                          {row.needsReviewer ? (
                            <span className="ml-2 type-meta text-[var(--warning)]">
                              needs reviewer
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={
                              row.agreement < threshold
                                ? "text-[var(--warning)]"
                                : "text-[var(--text-muted)]"
                            }
                          >
                            {pct(row.agreement)}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-[var(--text-muted)]">
                          {row.kappa != null ? row.kappa.toFixed(2) : "—"}
                        </td>
                        <td className="px-4 py-2 text-[var(--text-muted)]">
                          {row.annotationsCount != null
                            ? `${row.annotationsCount}/${row.annotationsRequired ?? 1}`
                            : "—"}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {row.needsReviewer ? (
                            <button
                              type="button"
                              className="ds-btn ds-btn-ghost ds-btn-sm"
                              disabled={escalateBusyId === row.itemId}
                              onClick={() => void escalateItem(row.itemId)}
                            >
                              Escalate
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                    {perItemSorted.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-4 text-[var(--text-faint)]">
                          {needsReviewerOnly
                            ? "No items currently need another reviewer at this threshold."
                            : "No items with 2+ annotations yet."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default function IaaDashboardPage() {
  return <IaaInner />;
}
