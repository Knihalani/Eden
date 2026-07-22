"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

export type RelatedLink = {
  href: string;
  label: string;
};

export type RelatedStripProps = {
  links: RelatedLink[];
  label?: string;
  ariaLabel?: string;
  className?: string;
};

/** Links-only related strip — never embed sibling routers. */
export function RelatedStrip({
  links,
  label = "Related",
  ariaLabel = "Related surfaces",
  className,
}: RelatedStripProps) {
  if (links.length === 0) return null;

  return (
    <nav
      aria-label={ariaLabel}
      data-testid="improve-related-strip"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-subtle)] pt-3 text-sm",
        className,
      )}
    >
      <span className="text-[var(--text-muted)]">{label}</span>
      {links.map((l) => (
        <Link
          key={`${l.href}-${l.label}`}
          href={l.href}
          className="text-[var(--accent)] hover:underline"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
