"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { QueryFilterBar } from "@/components/ui/query-filter-bar";
import { COST_TIME_PRESETS, costWindowHours } from "./cost-format";

type Props = {
  pastHours?: string;
  agentId?: string;
  q: string;
  onPastHoursChange: (hours: string) => void;
  onAgentIdChange: (agentId: string | undefined) => void;
  onSearchChange: (q: string) => void;
  /** Primary CTA (Create budget) — counts toward ≤5 toolbar actions. */
  cta?: ReactNode;
  displaySlot?: ReactNode;
};

export function CostHubToolbar({
  pastHours,
  agentId,
  q,
  onPastHoursChange,
  onAgentIdChange,
  onSearchChange,
  cta,
  displaySlot,
}: Props) {
  const t = useTranslations("cost");
  const hours = costWindowHours(pastHours);

  return (
    <div data-testid="cost-hub-toolbar">
      <QueryFilterBar
        filter={
          <>
            <div
              role="group"
              aria-label={t("time.aria")}
              className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1"
              data-testid="cost-time-range"
            >
              {COST_TIME_PRESETS.map((p) => (
                <Button
                  key={p.hours}
                  type="button"
                  size="sm"
                  variant={hours === p.hours ? "default" : "ghost"}
                  className="min-h-9"
                  onClick={() => onPastHoursChange(String(p.hours))}
                  aria-pressed={hours === p.hours}
                >
                  {t(p.labelKey)}
                </Button>
              ))}
            </div>
            {agentId ? (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 font-mono text-xs text-[var(--text-secondary)]"
                data-testid="cost-agent-chip"
              >
                {t("agentScoped", { agentId })}
                <button
                  type="button"
                  className="text-[var(--accent)] hover:underline"
                  onClick={() => onAgentIdChange(undefined)}
                >
                  {t("clearAgent")}
                </button>
              </span>
            ) : null}
          </>
        }
        display={displaySlot}
        search={
          <Input
            value={q}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-11 min-w-[10rem] max-w-xs"
            aria-label={t("searchPlaceholder")}
            data-testid="cost-search"
          />
        }
        overflow={cta}
      />
    </div>
  );
}
