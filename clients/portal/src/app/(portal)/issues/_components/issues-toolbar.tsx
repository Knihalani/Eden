"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { QueryFilterBar } from "@/components/ui/query-filter-bar";
import type { IssuesTab } from "./issue-map";

type Props = {
  tab: IssuesTab;
  q: string;
  severity: string;
  agentId?: string;
  pastHours?: string;
  onTabChange: (tab: IssuesTab) => void;
  onSearchChange: (q: string) => void;
  onSeverityChange: (severity: string) => void;
  onPastHoursChange: (hours: string) => void;
};

export function IssuesToolbar({
  tab,
  q,
  severity,
  agentId,
  pastHours,
  onTabChange,
  onSearchChange,
  onSeverityChange,
  onPastHoursChange,
}: Props) {
  const t = useTranslations("issues");

  return (
    <div data-testid="issues-toolbar">
      <QueryFilterBar
        view={
          <Tabs
            value={tab}
            onValueChange={(v) => onTabChange(v as IssuesTab)}
          >
            <TabsList variant="underline" aria-label={t("tabsAria")}>
              <TabsTrigger variant="underline" value="open" className="min-h-11">
                {t("tabs.open")}
              </TabsTrigger>
              <TabsTrigger variant="underline" value="all" className="min-h-11">
                {t("tabs.all")}
              </TabsTrigger>
              <TabsTrigger
                variant="underline"
                value="incidents"
                className="min-h-11"
              >
                {t("tabs.incidents")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
        filter={
          <>
            <select
              className="h-11 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm text-[var(--text-primary)]"
              value={severity}
              onChange={(e) => onSeverityChange(e.target.value)}
              aria-label={t("severityFilter")}
              data-testid="issues-severity-filter"
            >
              <option value="">{t("severityAll")}</option>
              <option value="critical">{t("severity.critical")}</option>
              <option value="high">{t("severity.high")}</option>
              <option value="med">{t("severity.med")}</option>
              <option value="low">{t("severity.low")}</option>
            </select>
            {agentId ? (
              <span
                className="rounded-md border border-[var(--border-subtle)] px-2 py-1 font-mono text-xs text-[var(--text-secondary)]"
                data-testid="issues-agent-chip"
              >
                {t("agentScoped", { agentId })}
              </span>
            ) : null}
          </>
        }
        search={
          <Input
            value={q}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-11 min-w-[10rem] max-w-xs"
            aria-label={t("searchPlaceholder")}
            data-testid="issues-search"
          />
        }
        time={
          <select
            className="h-11 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm text-[var(--text-primary)]"
            value={pastHours ?? "24"}
            onChange={(e) => onPastHoursChange(e.target.value)}
            aria-label={t("timeFilter")}
            data-testid="issues-time-filter"
          >
            <option value="1">{t("time.1h")}</option>
            <option value="24">{t("time.24h")}</option>
            <option value="168">{t("time.7d")}</option>
            <option value="720">{t("time.30d")}</option>
          </select>
        }
      />
    </div>
  );
}
