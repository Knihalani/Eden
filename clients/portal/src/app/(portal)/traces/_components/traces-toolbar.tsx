"use client";

import { useTranslations } from "next-intl";
import { QueryFilterBar } from "@/components/ui/query-filter-bar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ObserveOutcome, ObserveView } from "@/lib/observe-url";
import { cn } from "@/lib/utils";

const VIEWS: ObserveView[] = ["traces", "spans", "sessions"];
const PAST_HOURS = ["1", "6", "24", "72", "168"] as const;

type Props = {
  view: ObserveView;
  q: string;
  outcome: ObserveOutcome | undefined;
  pastHours: string;
  live: boolean;
  liveConnected?: boolean;
  liveFailed?: boolean;
  onViewChange: (view: ObserveView) => void;
  onSearchChange: (q: string) => void;
  onOutcomeChange: (outcome: ObserveOutcome | undefined) => void;
  onPastHoursChange: (hours: string) => void;
  onLiveChange: (live: boolean) => void;
};

export function TracesToolbar({
  view,
  q,
  outcome,
  pastHours,
  live,
  liveConnected,
  liveFailed,
  onViewChange,
  onSearchChange,
  onOutcomeChange,
  onPastHoursChange,
  onLiveChange,
}: Props) {
  const t = useTranslations("traces.toolbar");

  return (
    <div data-testid="traces-toolbar">
    <QueryFilterBar
      view={
        <div
          className="flex items-center gap-1"
          role="tablist"
          aria-label={t("viewLabel")}
          data-testid="traces-view-tabs"
        >
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              data-view={v}
              className={cn(
                "min-h-11 rounded-md px-3 text-sm transition-colors md:h-8 md:min-h-8",
                view === v
                  ? "bg-[var(--bg-tertiary)] font-medium text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
              onClick={() => onViewChange(v)}
            >
              {t(`views.${v}`)}
            </button>
          ))}
        </div>
      }
      filter={
        <select
          className="h-11 md:h-8 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-sm text-[var(--text-primary)]"
          value={outcome ?? ""}
          onChange={(e) =>
            onOutcomeChange(
              (e.target.value || undefined) as ObserveOutcome | undefined,
            )
          }
          aria-label={t("outcomeLabel")}
          data-testid="traces-outcome-filter"
        >
          <option value="">{t("outcomeAll")}</option>
          <option value="error">{t("outcomeError")}</option>
          <option value="ok">{t("outcomeOk")}</option>
          <option value="unknown">{t("outcomeUnknown")}</option>
        </select>
      }
      display={
        <div className="flex items-center gap-2" data-testid="traces-display">
          <Button
            type="button"
            size="sm"
            variant={live ? "default" : "secondary"}
            className="min-h-11 md:min-h-8 md:h-8"
            aria-pressed={live}
            onClick={() => onLiveChange(!live)}
            data-testid="traces-live-toggle"
          >
            {t("live")}
            {live ? (
              <span
                className="ml-1.5 inline-flex items-center gap-1 text-xs"
                aria-live="polite"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    liveFailed
                      ? "bg-[var(--warning)]"
                      : liveConnected
                        ? "bg-[var(--status-running)]"
                        : "bg-[var(--text-muted)]",
                  )}
                  aria-hidden
                />
                {liveFailed
                  ? t("liveDisconnected")
                  : liveConnected
                    ? t("liveOn")
                    : t("liveConnecting")}
              </span>
            ) : null}
          </Button>
        </div>
      }
      search={
        <Input
          value={q}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="h-11 md:h-8 w-full min-w-[10rem]"
          aria-label={t("searchPlaceholder")}
          data-testid="traces-search"
        />
      }
      time={
        <select
          className="h-11 md:h-8 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-sm text-[var(--text-primary)]"
          value={pastHours}
          onChange={(e) => onPastHoursChange(e.target.value)}
          aria-label={t("timeLabel")}
          data-testid="traces-past-hours"
        >
          {PAST_HOURS.map((h) => (
            <option key={h} value={h}>
              {t("hours", { hours: h })}
            </option>
          ))}
        </select>
      }
    />
    </div>
  );
}
