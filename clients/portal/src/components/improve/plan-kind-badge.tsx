"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { FileCode, MessageSquare, Shield, Settings, Sparkles } from "lucide-react";
import type { ImprovementPlanKind } from "@/lib/api";

const KIND_LABELS: Record<ImprovementPlanKind, string> = {
  code_patch: "Code patch",
  prompt_update: "Prompt update",
  nudge_promote: "Nudge promote",
  guardrail_tune: "Guardrail tune",
  config_change: "Config change",
};

const KIND_COLORS: Record<ImprovementPlanKind, string> = {
  code_patch: "bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20",
  prompt_update: "bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/20",
  nudge_promote: "bg-[var(--terminal)]/10 text-[var(--terminal)] border-[var(--terminal)]/20",
  guardrail_tune: "bg-[var(--error)]/10 text-[var(--error)] border-[var(--error)]/20",
  config_change: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]",
};

const KIND_ICONS: Record<ImprovementPlanKind, React.ComponentType<{ className?: string }>> = {
  code_patch: FileCode,
  prompt_update: MessageSquare,
  nudge_promote: Sparkles,
  guardrail_tune: Shield,
  config_change: Settings,
};

export function PlanKindBadge({
  kind,
  className,
}: {
  kind: ImprovementPlanKind | string;
  className?: string;
}) {
  const key = (kind in KIND_LABELS ? kind : "code_patch") as ImprovementPlanKind;
  const Icon = KIND_ICONS[key];
  return (
    <Badge variant="outline" className={cn("text-xs", KIND_COLORS[key], className)}>
      <Icon className="h-3 w-3 mr-1" />
      {KIND_LABELS[key]}
    </Badge>
  );
}
