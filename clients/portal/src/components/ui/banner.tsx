"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Banner — a persistent in-page notice that lives at the top of a
 * surface (above a table, beside a form). Distinct from <Toast>
 * (transient, auto-dismissing) and <Dialog> (modal, must-read).
 *
 * The `tone` controls the leading dot colour. June 2026 update:
 * added `error` and `success` tones (only accent/terminal/warning/
 * info existed before).
 */
export type BannerTone = "accent" | "terminal" | "warning" | "info" | "error" | "success";

export interface BannerProps {
  children: React.ReactNode;
  tone?: BannerTone;
  className?: string;
}

const TONE_DOT: Record<BannerTone, string> = {
  accent: "bg-[var(--accent)] shadow-[0_0_8px_var(--border-glow)]",
  terminal: "bg-[var(--terminal)] shadow-[0_0_8px_var(--terminal-glow)]",
  warning: "bg-[var(--warning)]",
  info: "bg-[var(--accent)] shadow-[0_0_8px_var(--border-glow)]",
  error: "bg-[var(--error)] shadow-[0_0_8px_var(--error)]/40",
  success: "bg-[var(--terminal)] shadow-[0_0_8px_var(--terminal-glow)]",
};

const TONE_BORDER: Record<BannerTone, string> = {
  accent: "border-[var(--accent)]/30",
  terminal: "border-[var(--terminal)]/30",
  warning: "border-[var(--warning)]/30",
  info: "border-[var(--accent)]/30",
  error: "border-[var(--error)]/40",
  success: "border-[var(--terminal)]/30",
};

export function Banner({ children, tone = "accent", className }: BannerProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--bg-primary)] text-xs font-mono text-[var(--text-secondary)] border",
        TONE_BORDER[tone],
        className,
      )}
    >
      <span
        className={cn("w-1.5 h-1.5 rounded-full animate-pulse", TONE_DOT[tone])}
        aria-hidden
      />
      {children}
    </div>
  );
}