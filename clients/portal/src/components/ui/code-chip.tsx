"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * CodeChip — inline pill that visually frames a code identifier
 * (CLI command, env var, file path, function name). Mono font, subtle
 * inset well. Replaces the repeated
 *   className="font-mono text-... bg-... px-1.5 py-0.5 rounded ..."
 * recipe that appeared 30+ times across pages and emails.
 */
export interface CodeChipProps extends React.HTMLAttributes<HTMLElement> {
  as?: "code" | "kbd" | "span";
  /** Visual size — defaults to "md" (~0.92em, matches inline body). */
  size?: "sm" | "md" | "lg";
}

const SIZE: Record<NonNullable<CodeChipProps["size"]>, string> = {
  sm: "text-[11px] px-1 py-0.5",
  md: "text-[0.92em] px-1.5 py-0.5",
  lg: "text-sm px-2 py-1",
};

export function CodeChip({
  as = "code",
  size = "md",
  className,
  ...props
}: CodeChipProps) {
  const Tag = as as React.ElementType;
  return (
    <Tag
      className={cn(
        "inline-flex items-center align-baseline gap-1",
        "font-mono text-[var(--text-primary)]",
        "bg-[var(--bg-tertiary)] rounded",
        "border border-[var(--border-subtle)]",
        "leading-none whitespace-nowrap",
        SIZE[size],
        className
      )}
      {...props}
    />
  );
}
