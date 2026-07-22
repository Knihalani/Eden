"use client";

import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GUARDRAILS_SEVERITIES, type GuardrailsTab } from "@/lib/guardrails-url";

type Props = {
  tab: GuardrailsTab;
  q: string;
  severity?: string;
  pastHours?: string;
  onSearchChange: (value: string) => void;
  onSeverityChange: (value: string | undefined) => void;
  onPastHoursChange: (value: string | undefined) => void;
};

const HOUR_OPTIONS = ["24", "72", "168"] as const;

export function GuardrailsHubToolbar({
  tab,
  q,
  severity,
  pastHours,
  onSearchChange,
  onSeverityChange,
  onPastHoursChange,
}: Props) {
  const t = useTranslations("guardrails");

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="guardrails-toolbar"
      data-chrome-band="toolbar"
    >
      <Input
        type="search"
        value={q}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={
          tab === "policies"
            ? t("toolbar.searchPolicies")
            : t("toolbar.searchViolations")
        }
        className="min-h-11 max-w-xs"
        aria-label={t("toolbar.searchAria")}
        data-testid="guardrails-search"
      />

      <Select
        value={severity ?? "all"}
        onValueChange={(v) => onSeverityChange(v === "all" ? undefined : v)}
      >
        <SelectTrigger
          className="min-h-11 w-[9.5rem]"
          aria-label={t("toolbar.severityAria")}
          data-testid="guardrails-severity-filter"
        >
          <SelectValue placeholder={t("toolbar.severityAll")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("toolbar.severityAll")}</SelectItem>
          {GUARDRAILS_SEVERITIES.map((s) => (
            <SelectItem key={s} value={s}>
              {t(`severity.${s}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {tab === "violations" ? (
        <Select
          value={pastHours ?? "24"}
          onValueChange={(v) =>
            onPastHoursChange(v === "24" ? undefined : v)
          }
        >
          <SelectTrigger
            className="min-h-11 w-[8rem]"
            aria-label={t("toolbar.pastHoursAria")}
            data-testid="guardrails-past-hours"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HOUR_OPTIONS.map((h) => (
              <SelectItem key={h} value={h}>
                {t("toolbar.hours", { count: Number(h) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
