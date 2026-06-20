"use client";

import Link from "next/link";
import { Home, Search, Compass } from "lucide-react";

/** Global 404 — ponytail: matches the dark-terminal design system so
 *  unknown routes (typos, dead links) don't fall through to Next's
 *  plain white 404. Three affordances: back-to-dashboard, search-via-
 *  command-palette, list-of-popular-routes. The route group folders
 *  ((portal), (auth), (marketing)) each have their own error.tsx; this
 *  one fires for genuinely missing paths.
 *
 *  "use client" so the command-palette dispatch works on click — the
 *  server-side prerender would otherwise reject onClick on a button
 *  (Next.js 15 RSC). */
export default function GlobalNotFound() {
  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-16">
      <div className="max-w-xl w-full text-center space-y-8">
        <div className="space-y-3">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--accent-faint)] text-[var(--accent)] text-[11px] font-mono uppercase tracking-wider border border-[var(--accent)]/20">
            <Compass className="w-3 h-3" />
            404 · Path not found
          </div>
          <h1 className="text-5xl font-bold tracking-tight text-[var(--text-primary)] font-mono">
            Lost in the trace
          </h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto leading-relaxed">
            The page you&apos;re looking for either moved, never existed, or the
            link is from a deploy that&apos;s no longer live. Try one of these:
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-left">
          <Link
            href="/dashboard"
            className="group block p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl hover:border-[var(--accent)]/50 hover:bg-[var(--bg-secondary)]/40 transition-all"
          >
            <Home className="w-4 h-4 text-[var(--accent)] mb-2" />
            <p className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
              Dashboard
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Live signals from your agents
            </p>
          </Link>
          <Link
            href="/traces"
            className="group block p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl hover:border-[var(--accent)]/50 hover:bg-[var(--bg-secondary)]/40 transition-all"
          >
            <Search className="w-4 h-4 text-[var(--accent)] mb-2" />
            <p className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
              Trace Explorer
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Search every trace in your system
            </p>
          </Link>
          <button
            type="button"
            onClick={() => {
              // The command palette listens for ⌘K — we can't open it
              // programmatically from a server component, so this card
              // instructs the user. The hotkey chip makes it discoverable.
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new KeyboardEvent("keydown", { key: "k", metaKey: true }),
                );
              }
            }}
            className="group block p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl hover:border-[var(--accent)]/50 hover:bg-[var(--bg-secondary)]/40 transition-all text-left"
          >
            <Search className="w-4 h-4 text-[var(--accent)] mb-2" />
            <p className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
              Search <kbd className="ml-1 px-1 py-0.5 bg-[var(--bg-base)] border border-[var(--border-default)] rounded text-[10px] font-mono text-[var(--text-muted)]">⌘K</kbd>
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Jump anywhere in the portal
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}