"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { QueryFilterBar } from "@/components/ui/query-filter-bar";

type Props = {
  q: string;
  filter?: string;
  agentId?: string;
  onSearchChange: (q: string) => void;
  /** Contextual primary CTA (New dataset / Run / Compare…). */
  cta?: ReactNode;
  /** Optional extra filter controls (grade chips, layout, …). */
  filterSlot?: ReactNode;
  displaySlot?: ReactNode;
};

export function EvalsHubToolbar({
  q,
  filter,
  agentId,
  onSearchChange,
  cta,
  filterSlot,
  displaySlot,
}: Props) {
  const t = useTranslations("evals");

  return (
    <div data-testid="evals-hub-toolbar">
      <QueryFilterBar
        filter={
          <>
            {filterSlot}
            {filter ? (
              <span
                className="rounded-md border border-[var(--border-subtle)] px-2 py-1 font-mono text-xs text-[var(--text-secondary)]"
                data-testid="evals-filter-chip"
              >
                {filter}
              </span>
            ) : null}
            {agentId ? (
              <span
                className="rounded-md border border-[var(--border-subtle)] px-2 py-1 font-mono text-xs text-[var(--text-secondary)]"
                data-testid="evals-agent-chip"
              >
                {t("agentScoped", { agentId })}
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
            data-testid="evals-search"
          />
        }
        overflow={cta}
      />
    </div>
  );
}
