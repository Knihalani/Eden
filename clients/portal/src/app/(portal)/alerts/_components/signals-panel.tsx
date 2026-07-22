"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { QueryState } from "@/components/ui/query-state";
import { Skeleton } from "@/components/ui/skeleton";
import { SeverityBadge } from "@/components/ui/status-badge";
import { CodeChip } from "@/components/ui/code-chip";
import { preserveObserveFilters } from "@/lib/observe-url";
import { cn } from "@/lib/utils";
import type { SignalRow } from "./alert-types";
import { formatRelativeTime } from "./alert-links";

type Props = {
  signals: SignalRow[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  selectedId?: string;
  onSelect: (signalId: string) => void;
  searchParams: URLSearchParams;
  onGoRules: () => void;
};

function signalTraceHref(
  signal: SignalRow,
  searchParams: URLSearchParams,
): string | null {
  if (!signal.traceId) return null;
  const params = preserveObserveFilters(searchParams);
  params.set("traceId", signal.traceId);
  if (signal.spanId) params.set("spanId", signal.spanId);
  if (signal.agentId) params.set("agentId", signal.agentId);
  const qs = params.toString();
  return qs ? `/traces?${qs}` : `/traces?traceId=${encodeURIComponent(signal.traceId)}`;
}

function signalIssueHref(signal: SignalRow): string | null {
  if (!signal.clusterIssueId) return null;
  return `/issues/${encodeURIComponent(signal.clusterIssueId)}`;
}

export function SignalsPanel({
  signals,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  searchParams,
  onGoRules,
}: Props) {
  const t = useTranslations("alerts.signals");
  const selected =
    signals.find((s) => s.signalId === selectedId) ?? signals[0] ?? null;

  return (
    <div
      className="flex flex-col gap-4 xl:flex-row xl:items-start"
      data-testid="alerts-signals-panel"
    >
      <div className="min-w-0 flex-1">
        <QueryState
          loading={loading}
          error={error}
          data={signals}
          onRetry={onRetry}
          isEmpty={(rows) => rows.length === 0}
          emptyKind="zero-data"
          loadingSlot={
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          }
          emptySlot={
            <EmptyState
              icon={Radar}
              variant="panel"
              title={t("empty.title")}
              description={t("empty.body")}
              action={
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" className="min-h-11">
                    <Link href="/traces">{t("empty.traces")}</Link>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11"
                    onClick={onGoRules}
                  >
                    {t("empty.rules")}
                  </Button>
                </div>
              }
            />
          }
        >
          {(rows) => (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                    <th className="px-3 py-2 font-medium">{t("colKind")}</th>
                    <th className="px-3 py-2 font-medium">{t("colMessage")}</th>
                    <th className="px-3 py-2 font-medium">{t("colAgent")}</th>
                    <th className="px-3 py-2 font-medium">{t("colTime")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const isSelected = row.signalId === selected?.signalId;
                    return (
                      <tr
                        key={row.signalId}
                        tabIndex={0}
                        data-selected={isSelected ? "true" : "false"}
                        className={cn(
                          "cursor-pointer border-b border-[var(--border-subtle)]",
                          "hover:bg-[var(--bg-tertiary)]",
                          isSelected && "bg-[var(--bg-tertiary)]",
                        )}
                        onClick={() => onSelect(row.signalId)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") onSelect(row.signalId);
                        }}
                      >
                        <td className="px-3 py-2.5">
                          <SeverityBadge severity={row.severity} />{" "}
                          <span className="font-mono text-[var(--text-secondary)]">
                            {row.kind}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-[var(--text-primary)]">
                          {row.message}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[var(--text-secondary)]">
                          {row.agentId ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[var(--text-secondary)]">
                          {formatRelativeTime(row.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </div>

      {selected ? (
        <Panel
          tone="flat"
          padding="md"
          className="w-full xl:max-w-md"
          data-testid="signal-detail"
        >
          <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">
            {selected.kind}
          </h3>
          <p className="mt-2 m-0 text-sm text-[var(--text-secondary)]">
            {selected.message}
          </p>
          {selected.confidence != null ? (
            <p className="mt-2 m-0 text-xs text-[var(--text-muted)]">
              {t("confidence", {
                value: Math.round(selected.confidence * 100),
              })}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {selected.traceId ? (
              <CodeChip>{selected.traceId}</CodeChip>
            ) : null}
            {selected.clusterIssueId ? (
              <CodeChip>{selected.clusterIssueId}</CodeChip>
            ) : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {signalTraceHref(selected, searchParams) ? (
              <Button asChild size="sm" className="min-h-11">
                <Link href={signalTraceHref(selected, searchParams)!}>
                  {t("openTrace")}
                </Link>
              </Button>
            ) : null}
            {signalIssueHref(selected) ? (
              <Button asChild size="sm" variant="secondary" className="min-h-11">
                <Link href={signalIssueHref(selected)!}>{t("openIssue")}</Link>
              </Button>
            ) : (
              <Button asChild size="sm" variant="secondary" className="min-h-11">
                <Link
                  href={
                    selected.traceId
                      ? `/issues?traceId=${encodeURIComponent(selected.traceId)}`
                      : "/issues"
                  }
                >
                  {t("attachIssue")}
                </Link>
              </Button>
            )}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
