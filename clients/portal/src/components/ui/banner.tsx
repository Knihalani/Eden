"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface BannerProps {
  children: React.ReactNode;
  variant?: "accent" | "terminal" | "warning" | "info";
  className?: string;
}

const VARIANT_DOT: Record<NonNullable<BannerProps["variant"]>, string> = {
  accent: "bg-[var(--accent)] shadow-[0_0_8px_var(--accent-glow)]",
  terminal: "bg-[var(--terminal)] shadow-[0_0_8px_var(--terminal-glow)]",
  warning: "bg-[var(--warning)]",
  info: "bg-[var(--accent)] shadow-[0_0_8px_var(--accent-glow)]",
};

export function Banner({ children, variant = "accent", className }: BannerProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-primary)] text-xs font-mono text-[var(--text-secondary)]",
        className,
      )}
    >
      <span
        className={cn("w-1.5 h-1.5 rounded-full animate-pulse", VARIANT_DOT[variant])}
        aria-hidden
      />
      {children}
    </div>
  );
}
