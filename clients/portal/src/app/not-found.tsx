"use client";

import Link from "next/link";
import { CodeChip } from "@/components/ui/code-chip";
import { Panel } from "@/components/ui/panel";
import { usePathname } from "next/navigation";
import { Home, Compass, ArrowRight, Activity, Bot, Sparkles, Bell } from "lucide-react";

/**
 * Global 404 — ponytail: matches the dark-terminal design system so
 * unknown routes (typos, dead links) don't fall through to Next's
 * plain white 404. June 2026 update: surfaces the typed path so the
 * user knows what URL was tried, and offers category-grouped popular
 * destinations so they can navigate by intent rather than guess.
 */
const POPULAR: Array<{
  group: string;
  items: Array<{ href: string; icon: typeof Home; label: string; description: string }>;
}> = [
  {
    group: "Build",
    items: [
      { href: "/dashboard", icon: Home, label: "Dashboard", description: "Live signals from your agents" },
      { href: "/agents", icon: Bot, label: "Agents", description: "Manage your agent fleet" },
    ] },
  {
    group: "Observe",
    items: [
      { href: "/traces", icon: Activity, label: "Traces", description: "Search every trace in your system" },
      { href: "/incidents", icon: Bell, label: "Incidents", description: "Open RCA clusters" },
    ] },
  {
    group: "Optimize",
    items: [
      { href: "/optimization", icon: Sparkles, label: "Cost", description: "Token + cost overview" },
      { href: "/alerts", icon: Bell, label: "Alerts", description: "Active alerts and rules" },
    ] },
];

export default function GlobalNotFound() {
  const pathname = usePathname();
  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-16">
      <div className="max-w-3xl w-full text-center space-y-8">
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
            link is from a deploy that&apos;s no longer live.
          </p>
          {pathname && pathname !== "/" && (
            <CodeChip as="span" size="md" className="mt-2">
              {pathname}
            </CodeChip>
          )}
        </div>

        {/* Category-grouped popular routes. Renders 3 columns on lg,
            1 column on mobile. Mirrors the sidebar grouping so users
            can navigate by intent (e.g. "I want to look at traces").
            Wrapped in a flat Panel so it reads as a coherent surface
            group rather than three floating lists. */}
        <Panel tone="flat" padding="md" className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left bg-[var(--bg-secondary)]/60">
          {POPULAR.map((group) => (
            <div key={group.group} className="space-y-2">
              <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)] px-1">
                {group.group}
              </p>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group flex items-start gap-3 p-3 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg hover:border-[var(--accent)]/50 hover:bg-[var(--bg-secondary)]/40 transition-all"
                  >
                    <Icon className="w-4 h-4 text-[var(--accent)] mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors truncate">
                        {item.label}
                      </p>
                      <p className="text-xs text-[var(--text-muted)] truncate">
                        {item.description}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          ))}
        </Panel>

        <div className="flex items-center justify-center gap-3 pt-2">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)] text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Back to dashboard
            <ArrowRight className="w-3.5 h-3.5" />
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
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            Search
            <kbd className="ml-1 px-1 py-0.5 bg-[var(--bg-base)] border border-[var(--border-default)] rounded text-[10px] font-mono text-[var(--text-muted)]">⌘K</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}