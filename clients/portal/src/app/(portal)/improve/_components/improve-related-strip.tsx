"use client";

import Link from "next/link";

import { RELATED_LINKS } from "./improve-constants";

export function ImproveRelatedStrip() {
  return (
    <nav
      data-testid="improve-related-strip"
      aria-label="Related"
      className="flex flex-wrap items-center gap-x-space-3 gap-y-1 text-xs text-[var(--text-muted)]"
    >
      <span className="font-medium uppercase tracking-wide text-[var(--text-faint)]">
        Related
      </span>
      {RELATED_LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="text-[var(--accent)] hover:underline"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
