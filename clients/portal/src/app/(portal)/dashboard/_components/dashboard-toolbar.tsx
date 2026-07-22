"use client";

import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

const WINDOWS = [1, 6, 24, 72, 168] as const;

type Props = {
  pastHours: number;
  live: boolean;
  onLiveChange: (live: boolean) => void;
  agentOptions: Array<{ id: string; name: string }>;
};

export function DashboardToolbar({
  pastHours,
  live,
  onLiveChange,
  agentOptions,
}: Props) {
  const t = useTranslations("dashboard.toolbar");
  const router = useRouter();
  const searchParams = useSearchParams();

  function update(patch: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    router.replace(qs ? `/dashboard?${qs}` : "/dashboard");
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="dashboard-toolbar"
    >
      <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <span className="sr-only">{t("pastHours")}</span>
        <select
          className="h-11 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
          value={pastHours}
          onChange={(e) => update({ pastHours: e.target.value })}
          aria-label={t("pastHours")}
        >
          {WINDOWS.map((h) => (
            <option key={h} value={h}>
              {t("hours", { count: h })}
            </option>
          ))}
        </select>
      </label>

      <select
        className="h-11 max-w-[12rem] rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
        value={searchParams.get("agentId") ?? ""}
        onChange={(e) => update({ agentId: e.target.value || null })}
        aria-label={t("agentFilter")}
      >
        <option value="">{t("allAgents")}</option>
        {agentOptions.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>

      <Button
        type="button"
        size="sm"
        variant={live ? "secondary" : "ghost"}
        className="min-h-11"
        onClick={() => onLiveChange(!live)}
        aria-pressed={live}
      >
        {live ? t("liveOn") : t("liveOff")}
      </Button>
    </div>
  );
}
