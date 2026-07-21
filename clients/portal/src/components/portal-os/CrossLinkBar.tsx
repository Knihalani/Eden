"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CrossLinkItem {
  label: string;
  href: string;
  external?: boolean;
}

export interface CrossLinkBarProps {
  links: CrossLinkItem[];
  className?: string;
  /** Hard cap — Wave 6 diet; default 4 related links. */
  maxLinks?: number;
}

/** Compact cross-link row for detail panels — muted text links, not accent chip walls. */
export function CrossLinkBar({
  links,
  className,
  maxLinks = 4,
}: CrossLinkBarProps) {
  const shown = links.slice(0, maxLinks);
  if (shown.length === 0) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1.5",
        className,
      )}
      role="navigation"
      aria-label="Related resources"
      data-wave6-crosslink="diet"
    >
      <span className="text-[length:var(--font-size-2xs)] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Related
      </span>
      {shown.map((link) => (
        <Link
          key={`${link.href}-${link.label}`}
          href={link.href}
          className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
        >
          {link.label}
          {link.external ? <ExternalLink className="h-3 w-3" aria-hidden /> : null}
        </Link>
      ))}
    </div>
  );
}
