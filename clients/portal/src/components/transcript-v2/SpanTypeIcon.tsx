"use client";

import { AlertCircle, Bot, MessageSquare, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type SpanKind,
  spanKindColor,
  spanKindLabel,
} from "./span-kind";

const KIND_ICON = {
  llm: MessageSquare,
  tool: Wrench,
  subagent: Bot,
  error: AlertCircle,
  span: MessageSquare,
} as const;

export function SpanTypeIcon({
  kind,
  className,
}: {
  kind: SpanKind;
  className?: string;
}) {
  const Icon = KIND_ICON[kind];
  const color = spanKindColor(kind);
  return (
    <Icon
      className={cn("h-3.5 w-3.5 shrink-0", className)}
      style={{ color }}
      data-testid="span-type-icon"
      aria-hidden
    />
  );
}

export function SpanKindPill({
  kind,
  className,
}: {
  kind: SpanKind;
  className?: string;
}) {
  const color = spanKindColor(kind);
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-2xs font-medium",
        className,
      )}
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
      data-testid="span-kind-pill"
    >
      <SpanTypeIcon kind={kind} className="h-3 w-3" />
      {spanKindLabel(kind)}
    </span>
  );
}
