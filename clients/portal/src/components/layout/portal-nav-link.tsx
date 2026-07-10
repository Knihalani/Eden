"use client";

import type { ComponentPropsWithoutRef } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { cn, isExternalHref } from "@/lib/utils";

type PortalNavLinkProps = ComponentPropsWithoutRef<"a"> & {
  href: string;
  /** Show a small external-link icon (sidebar docs item). */
  showExternalIcon?: boolean;
};

/**
 * Renders Next.js Link for in-app routes and a plain anchor with
 * target=_blank for external URLs (e.g. docs.edenobservability.com).
 */
export function PortalNavLink({
  href,
  className,
  children,
  showExternalIcon = false,
  onClick,
  ...rest
}: PortalNavLinkProps) {
  if (isExternalHref(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onClick={onClick}
        {...rest}
      >
        {children}
        {showExternalIcon && (
          <ExternalLink className="w-3 h-3 shrink-0 opacity-60" aria-hidden />
        )}
      </a>
    );
  }

  return (
    <Link href={href} className={className} onClick={onClick} {...rest}>
      {children}
    </Link>
  );
}

/** Shared row styles for sidebar search result links. */
export function sidebarSearchResultClass(isActive: boolean): string {
  return cn(
    "flex items-center gap-2.5 px-3 py-2 text-xs transition-colors",
    isActive
      ? "bg-[var(--accent-faint)] text-[var(--text-primary)]"
      : "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]",
  );
}
