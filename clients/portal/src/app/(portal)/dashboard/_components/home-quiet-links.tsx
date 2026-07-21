"use client";

import Link from "next/link";
import { HOME_QUIET_LINKS } from "./home-widgets";

/**
 * Optional quiet destinations under the decision surface — text links only.
 * Not a Quick Links card collage (Wave 7).
 */
export function HomeQuietLinks() {
  return (
    <nav
      aria-label="Home shortcuts"
      data-home-shell-links="quiet"
      className="flex flex-wrap items-center gap-x-space-2 gap-y-space-1 pt-space-1"
    >
      <span className="text-xs text-[var(--text-faint)] mr-space-1">Also</span>
      {HOME_QUIET_LINKS.map((item, i) => (
        <span key={item.href} className="inline-flex items-center gap-x-space-2">
          {i > 0 ? (
            <span className="text-[var(--text-faint)] text-xs select-none" aria-hidden>
              ·
            </span>
          ) : null}
          <Link
            href={item.href}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-150"
          >
            {item.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
