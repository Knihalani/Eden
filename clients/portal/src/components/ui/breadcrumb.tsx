"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarGroupId } from "@/lib/breadcrumbs";
import { GROUP_LABEL } from "@/lib/nav-commands";

export interface BreadcrumbItem {
  label: string;
  href?: string;
  /** Sidebar group — optional "Observe · …" prefix on the last crumb. */
  category?: SidebarGroupId;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
  /** Home root icon link. Default `/dashboard`. Pass `null` to omit. */
  homeHref?: string | null;
  /** Collapse middle crumbs when `items.length > 2` (shell deep paths). */
  collapseDeep?: boolean;
  /** Prefix last crumb with `GROUP_LABEL[category] ·`. */
  showCategoryPrefix?: boolean;
}

/**
 * Kit breadcrumb — single API for portal chrome (home root, deep-path
 * ellipsis, optional category prefix). Prefer this over inline crumbs.
 */
export function Breadcrumb({
  items,
  className,
  homeHref = "/dashboard",
  collapseDeep = false,
  showCategoryPrefix = false,
}: BreadcrumbProps) {
  const visible =
    collapseDeep && items.length > 2
      ? [items[items.length - 2], items[items.length - 1]]
      : items;

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex items-center gap-1 text-xs min-w-0", className)}
    >
      {homeHref != null && (
        <Link
          href={homeHref}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
          aria-label="Home"
        >
          <Home className="w-3.5 h-3.5" />
        </Link>
      )}
      {visible.map((crumb, index) => {
        const isLast = index === visible.length - 1;
        const showEllipsis = collapseDeep && items.length > 2 && index === 0;
        const categoryPrefix =
          showCategoryPrefix && isLast && crumb.category
            ? `${GROUP_LABEL[crumb.category]} · `
            : "";
        const key = crumb.href ?? `${crumb.label}-${index}`;

        return (
          <span key={key} className="flex items-center gap-1 min-w-0">
            {showEllipsis ? (
              <>
                <span className="text-[var(--text-muted)]" aria-hidden>
                  …
                </span>
                <ChevronRight className="w-2.5 h-2.5 text-[var(--text-muted)]" />
              </>
            ) : (
              (homeHref != null || index > 0) && (
                <ChevronRight className="w-2.5 h-2.5 text-[var(--text-muted)]" />
              )
            )}
            {isLast || !crumb.href ? (
              <span
                className={cn(
                  "truncate",
                  isLast
                    ? "font-medium text-[var(--text-secondary)]"
                    : "text-[var(--text-muted)]",
                )}
                title={categoryPrefix + crumb.label}
              >
                {categoryPrefix ? (
                  <span className="text-[var(--text-muted)] font-normal">
                    {categoryPrefix}
                  </span>
                ) : null}
                {crumb.label}
              </span>
            ) : (
              <Link
                href={crumb.href}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors truncate"
              >
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
