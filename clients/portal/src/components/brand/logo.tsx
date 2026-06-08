"use client";

import Link from "next/link";
import { Layers } from "lucide-react";
import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  showWordmark?: boolean;
  size?: "sm" | "md";
}

export function Logo({ className, showWordmark = true, size = "md" }: LogoProps) {
  const iconSize = size === "sm" ? "w-10 h-10" : "w-12 h-12";
  const iconInner = size === "sm" ? "w-5 h-5" : "w-6 h-6";
  const textSize = size === "sm" ? "text-xl" : "text-2xl";

  return (
    <Link href="/dashboard" className={cn("flex items-center gap-3.5 min-w-0 group", className)}>
      <div
        className={cn(
          iconSize,
          "bg-gradient-to-br from-[var(--accent)] to-[var(--terminal)] rounded-2xl flex items-center justify-center flex-shrink-0 shadow-lg shadow-[var(--accent)]/20 group-hover:shadow-xl group-hover:shadow-[var(--accent)]/40 transition-all duration-300 group-hover:scale-105"
        )}
      >
        <Layers className={cn(iconInner, "text-[var(--bg-base)]")} aria-hidden />
      </div>
      {showWordmark && (
        <span className={cn(textSize, "font-bold text-[var(--text-primary)] truncate tracking-tight")}>
          Eden
        </span>
      )}
    </Link>
  );
}