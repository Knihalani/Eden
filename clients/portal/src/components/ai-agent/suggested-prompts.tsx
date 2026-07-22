"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { AiContextItem } from "@/lib/context-model";
import { cn } from "@/lib/utils";

interface SuggestedPromptsProps {
  context: AiContextItem[];
  onSelect: (prompt: string) => void;
  className?: string;
}

export function SuggestedPrompts({ context, onSelect, className }: SuggestedPromptsProps) {
  const t = useTranslations("ai.suggestions");

  const prompts = buildPrompts(context, t);

  if (prompts.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-2 px-4 pb-3", className)}>
      {prompts.map((prompt) => (
        <Button
          key={prompt}
          size="sm"
          variant="secondary"
          onClick={() => onSelect(prompt)}
          className="text-xs"
        >
          {prompt}
        </Button>
      ))}
    </div>
  );
}

function buildPrompts(
  context: AiContextItem[],
  t: ReturnType<typeof useTranslations>,
): string[] {
  if (context.length === 0) {
    return [t("noContext")];
  }
  const types = context.map((c) => c.type);
  if (types.includes("trace")) {
    return [t("traceAttached"), t("proposeFixPlan")];
  }
  if (types.includes("issue")) {
    return [t("issueAttached"), t("proposeFixPlan")];
  }
  if (types.includes("debuggerSession")) {
    return [t("debuggerAttached")];
  }
  return [t("generic")];
}
