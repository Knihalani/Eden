"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { usePermissions } from "@/hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { CitationChip } from "./citation-chip";
import type { ActionCard as ActionCardType } from "./types";
import { cn } from "@/lib/utils";

interface ActionCardProps {
  card: ActionCardType;
  onConfirm?: (card: ActionCardType) => void;
  className?: string;
}

export function ActionCard({ card, onConfirm, className }: ActionCardProps) {
  const t = useTranslations("ai.actionCard");
  const router = useRouter();
  const { role } = usePermissions();
  const canMutate = role !== "viewer";

  const handleConfirm = () => {
    onConfirm?.(card);
    if (card.confirmHref && card.type !== "explain") {
      router.push(card.confirmHref);
    }
  };

  const actionLabel = {
    explain: t("explain"),
    propose_fix: t("proposeFix"),
    open_plan: t("openPlan"),
    open_pr: t("openPr"),
  }[card.type] ?? t("confirm");

  return (
    <div
      className={cn(
        "rounded-md border border-[var(--border-default)] bg-[var(--bg-inset)] p-3",
        className,
      )}
    >
      <p className="mb-1 text-sm font-medium text-[var(--text-primary)]">{card.title}</p>
      {card.body && (
        <p className="mb-2 text-xs text-[var(--text-secondary)]">{card.body}</p>
      )}
      {card.evidence && card.evidence.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {card.evidence.map((cit) => (
            <CitationChip key={`${cit.kind}-${cit.id}`} citation={cit} />
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        {/* Explain stays in chat — no mutate required */}
        {card.type === "explain" && (
          <Button size="sm" variant="secondary" onClick={handleConfirm}>
            {actionLabel}
          </Button>
        )}
        {/* Mutate actions — hide for Viewer */}
        {card.type !== "explain" && canMutate && !card.confirmed && (
          <Button size="sm" variant="secondary" onClick={handleConfirm}>
            {actionLabel}
          </Button>
        )}
        {card.confirmed && (
          <span className="text-xs text-[var(--terminal)]">{t("confirmed")}</span>
        )}
      </div>
    </div>
  );
}
