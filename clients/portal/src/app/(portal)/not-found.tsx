"use client";

/**
 * (portal)-scoped not-found page.
 *
 * ui-audit 2026-07-08: Without this segment, an unknown URL inside
 * (portal) renders the global app/not-found.tsx (the marketing 404),
 * which means the user loses their sidebar/header context — looks
 * like they've been kicked out of the portal. This component
 * preserves the (portal) chrome via the surrounding layout and
 * offers a fast path back to /dashboard plus a search affordance.
 */

import Link from "next/link";
import { Home, Compass, ArrowRight } from "lucide-react";

export default function PortalNotFound() {
  return (
    <div className="flex items-center justify-center min-h-[70vh] px-4 py-12">
      <div className="max-w-lg w-full text-center space-y-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-default)] mx-auto">
          <Compass className="w-8 h-8 text-[var(--text-muted)]" />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-mono font-semibold uppercase tracking-widest text-[var(--accent)]">
            404
          </p>
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
            We can&apos;t find that page
          </h1>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            The URL doesn&apos;t match a portal route. The sidebar on the left
            lists every page in this app — or press{" "}
            <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded font-mono text-xs">
              ⌘K
            </kbd>{" "}
            to search.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3 pt-2">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <Home className="w-4 h-4" />
            Go to dashboard
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <Link
            href="/settings?tab=sidebar"
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] transition-colors"
          >
            <Compass className="w-4 h-4" />
            Browse all pages
          </Link>
        </div>
      </div>
    </div>
  );
}
