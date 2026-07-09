"use client";

/**
 * PageHelpHint — auto-renders a one-line "what is this page for"
 * tooltip below every portal page's title so users don't have to
 * guess from the sidebar. Reads the description from the central
 * `page-descriptions` map keyed by pathname.
 *
 * This is a portal-wide navigation-clarity win: with ~30 routes,
 * users reported "I don't know what's for what". The hint shows
 * only on hover of a small info icon — it doesn't add visual
 * clutter to every page; the user has to actively want the hint.
 */

import { Info } from "lucide-react";
import { usePathname } from "next/navigation";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { getPageDescription } from "@/lib/page-descriptions";

export function PageHelpHint() {
  const pathname = usePathname();
  const description = getPageDescription(pathname);
  if (!description) return null;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="What is this page for?"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          <Info className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">About this page</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-[320px]">
        <div className="font-medium text-[var(--text-primary)] mb-0.5">About this page</div>
        <div className="text-xs text-[var(--text-secondary)] leading-snug">
          {description}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
