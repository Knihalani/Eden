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
}

/** Compact cross-link row for detail panels (U19 matrix). */
export function CrossLinkBar({ links, className }: CrossLinkBarProps) {
  if (links.length === 0) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-[var(--border-default)] px-4 py-2",
        className,
      )}
      role="navigation"
      aria-label="Related resources"
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Go to
      </span>
      {links.map((link) => (
        <Link
          key={`${link.href}-${link.label}`}
          href={link.href}
          className="inline-flex items-center gap-1 rounded-md bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent-faint)]"
        >
          {link.label}
          {link.external ? <ExternalLink className="h-3 w-3" /> : null}
        </Link>
      ))}
    </div>
  );
}
