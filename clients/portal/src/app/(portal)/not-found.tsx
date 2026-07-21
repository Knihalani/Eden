"use client";

/**
 * (portal)-scoped not-found page.
 *
 * Without this segment, an unknown URL inside (portal) renders the global
 * app/not-found.tsx (the marketing 404), which means the user loses their
 * sidebar/header context. This component preserves the (portal) chrome via
 * the surrounding layout and offers a fast path back to /dashboard.
 */

import Link from "next/link";
import { Home, Compass, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

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
          <Button asChild>
            <Link href="/dashboard">
              <Home className="w-4 h-4" />
              Go to dashboard
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/settings?tab=sidebar">
              <Compass className="w-4 h-4" />
              Browse all pages
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
