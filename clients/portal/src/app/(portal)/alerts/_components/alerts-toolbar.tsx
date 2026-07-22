"use client";

import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { QueryFilterBar } from "@/components/ui/query-filter-bar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { AlertsTab } from "./alert-types";
import { ALERTS_TABS } from "./alert-types";

type Props = {
  tab: AlertsTab;
  onTabChange: (tab: AlertsTab) => void;
  q: string;
  onSearch: (value: string) => void;
  statusFilter: string;
  onStatusFilter: (value: string) => void;
  severityFilter: string;
  onSeverityFilter: (value: string) => void;
  pastHours: string;
  onPastHours: (value: string) => void;
  live: boolean;
  onLiveChange: (live: boolean) => void;
  showLiveToggle: boolean;
};

export function AlertsToolbar({
  tab,
  onTabChange,
  q,
  onSearch,
  statusFilter,
  onStatusFilter,
  severityFilter,
  onSeverityFilter,
  pastHours,
  onPastHours,
  live,
  onLiveChange,
  showLiveToggle,
}: Props) {
  const t = useTranslations("alerts");

  return (
    <div data-testid="alerts-toolbar">
      <QueryFilterBar
        view={
          <Tabs
            value={tab}
            onValueChange={(v) => onTabChange(v as AlertsTab)}
          >
            <TabsList variant="underline" aria-label={t("tabsAria")}>
              {ALERTS_TABS.map((id, index) => (
                <TabsTrigger
                  key={id}
                  variant="underline"
                  value={id}
                  className="min-h-11"
                  data-shortcut={String(index + 1)}
                >
                  {t(`tabs.${id}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
        filter={
          tab === "inbox" ? (
            <>
              <select
                className="h-11 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm text-[var(--text-primary)]"
                value={statusFilter}
                onChange={(e) => onStatusFilter(e.target.value)}
                aria-label={t("filters.status")}
              >
                <option value="">{t("filters.statusAll")}</option>
                <option value="open">{t("status.open")}</option>
                <option value="acked">{t("status.acked")}</option>
              </select>
              <select
                className="h-11 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm text-[var(--text-primary)]"
                value={severityFilter}
                onChange={(e) => onSeverityFilter(e.target.value)}
                aria-label={t("filters.severity")}
              >
                <option value="">{t("filters.severityAll")}</option>
                <option value="critical">{t("severity.critical")}</option>
                <option value="high">{t("severity.high")}</option>
                <option value="medium">{t("severity.medium")}</option>
                <option value="low">{t("severity.low")}</option>
              </select>
            </>
          ) : undefined
        }
        search={
          <Input
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-11 min-w-[10rem] max-w-xs"
            aria-label={t("searchPlaceholder")}
          />
        }
        time={
          tab === "inbox" ? (
            <select
              className="h-11 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm text-[var(--text-primary)]"
              value={pastHours}
              onChange={(e) => onPastHours(e.target.value)}
              aria-label={t("filters.pastHours")}
            >
              <option value="1">{t("filters.hours", { count: 1 })}</option>
              <option value="6">{t("filters.hours", { count: 6 })}</option>
              <option value="24">{t("filters.hours", { count: 24 })}</option>
              <option value="72">{t("filters.hours", { count: 72 })}</option>
              <option value="168">{t("filters.hours", { count: 168 })}</option>
            </select>
          ) : undefined
        }
        display={
          showLiveToggle && tab === "inbox" ? (
            <Button
              type="button"
              size="sm"
              variant={live ? "default" : "secondary"}
              className={cn("min-h-11 gap-2", live && "text-[var(--terminal)]")}
              onClick={() => onLiveChange(!live)}
              aria-pressed={live}
              data-testid="alerts-live-toggle"
            >
              {live ? (
                <span
                  className="inline-block h-2 w-2 rounded-full bg-[var(--terminal)]"
                  aria-hidden
                />
              ) : null}
              {live ? t("live.on") : t("live.off")}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
