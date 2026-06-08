"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex items-center gap-1.5 text-xs", className)}
    >
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <React.Fragment key={`${item.label}-${idx}`}>
            {item.href && !isLast ? (
              <Link
                href={item.href}
                className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={cn(
                  isLast
                    ? "text-[var(--text-primary)] font-medium"
                    : "text-[var(--text-muted)]",
                )}
              >
                {item.label}
              </span>
            )}
            {!isLast && (
              <ChevronRight className="w-3 h-3 text-[var(--text-faint)]" />
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
