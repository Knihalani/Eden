"use client";

import { useTranslations } from "next-intl";
import { CitationChip } from "./citation-chip";
import { citationHref, citationLabel } from "@/lib/citation-href";
import type { AiContextItem } from "@/lib/context-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ContextPanelProps {
  items: AiContextItem[];
  onRemove: (index: number) => void;
  className?: string;
}

export function ContextPanel({ items, onRemove, className }: ContextPanelProps) {
  const t = useTranslations("ai.context");

  const toCitationTarget = (item: AiContextItem) => ({
    kind: item.type as import("@/lib/citation-href").CitationKind,
    id: item.id,
    secondaryId: item.secondaryId,
  });

  return (
    <aside
      className={cn("flex flex-col gap-2 border-l border-[var(--border-subtle)] p-3", className)}
      aria-label={t("ariaLabel")}
    >
      <p className="text-xs font-medium text-[var(--text-muted)]">{t("title")}</p>
      {items.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">{t("empty")}</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {items.map((item, i) => (
            <CitationChip
              key={`${item.type}-${item.id}-${i}`}
              citation={toCitationTarget(item)}
              onRemove={() => onRemove(i)}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-[var(--text-muted)]">{t("hint")}</p>
    </aside>
  );
}
