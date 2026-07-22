"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { FleetAgentCard } from "@/lib/api";
import { StatusBadge } from "@/components/ui/status-badge";
import { AGENT_HEALTH_STATUSES, type AgentHealthStatus } from "@/lib/agent-health";
import { cn } from "@/lib/utils";

function fleetStatus(card: FleetAgentCard): AgentHealthStatus {
  if ((card.open_p0_issues ?? 0) > 0 || card.slo_breach) return "failing";
  if (card.open_issues > 0 || card.drift_flagged) return "degraded";
  if (!card.last_seen) return "unknown";
  return "healthy";
}

type Props = {
  agents: FleetAgentCard[];
};

export function FleetHealthTable({ agents }: Props) {
  const t = useTranslations("agents.fleet");
  const router = useRouter();

  if (agents.length === 0) return null;

  return (
    <div className="overflow-x-auto" data-testid="fleet-health-table">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2 font-medium">{t("colName")}</th>
            <th className="px-3 py-2 font-medium">{t("colStatus")}</th>
            <th className="px-3 py-2 font-medium">{t("colIssues")}</th>
            <th className="px-3 py-2 font-medium">{t("colStumbles")}</th>
            <th className="px-3 py-2 font-medium">{t("colEval")}</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((card) => {
            const status = fleetStatus(card);
            const name = card.display_name || card.agent_id;
            return (
              <tr
                key={card.agent_id}
                className={cn(
                  "cursor-pointer border-b border-[var(--border-subtle)]",
                  "hover:bg-[var(--bg-tertiary)]",
                )}
                onClick={() =>
                  router.push(`/agents/${encodeURIComponent(card.agent_id)}`)
                }
              >
                <td className="px-3 py-2.5">
                  <Link
                    href={`/agents/${encodeURIComponent(card.agent_id)}`}
                    className="font-medium text-[var(--text-primary)] hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {name}
                  </Link>
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge
                    status={status}
                    descriptors={AGENT_HEALTH_STATUSES}
                  />
                </td>
                <td className="px-3 py-2.5 font-mono">{card.open_issues}</td>
                <td className="px-3 py-2.5 font-mono">
                  {card.stumble_count_7d}
                </td>
                <td className="px-3 py-2.5 font-mono">
                  {card.eval_pass_rate_24h != null
                    ? `${(card.eval_pass_rate_24h * 100).toFixed(0)}%`
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
