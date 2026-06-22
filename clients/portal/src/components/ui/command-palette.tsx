"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Command as Cmnd } from "cmdk";
import { useRouter, usePathname } from "next/navigation";
import {
  Search,
  Plus,
  Bot,
  Wand2,
  Box,
  Network,
  Server,
  Activity,
  Layers,
  Brain,
  Compass,
  Bell,
  Cog,
  Sparkles,
  FlaskConical,
  Shield,
  Inbox,
  GitPullRequestArrow,
  BarChart3,
  Settings,
  CreditCard,
  FileText,
  User,
  Users,
  X,
  ChevronRight,
  Wrench,
  PlayCircle,
  Gauge,
  Database,
  GitBranch,
  Library,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  COMMAND_PALETTE_RECENT_KEY,
  COMMAND_PALETTE_RECENT_LIMIT,
} from "@/lib/constants";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type NavEntry = {
  href: string;
  label: string;
  description?: string;
  group: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: "accent" | "terminal" | "muted";
};

// Single source of truth for the command palette. Mirrors the
// sidebar groups in `(portal)/layout.tsx` so anything the user can
// reach from the sidebar is also reachable from Cmd+K.
const COMMANDS: NavEntry[] = [
  // Build
  { href: "/dashboard", label: "Dashboard", description: "Org-level metrics and recent activity", group: "Build", icon: Sparkles, accent: "terminal" },
  { href: "/agents", label: "Agents", description: "Manage registered agents", group: "Build", icon: Bot },
  { href: "/builder", label: "Builder", description: "Scaffold new agent configs", group: "Build", icon: Wand2, accent: "accent" },
  { href: "/marketplace", label: "Marketplace", description: "Browse community agents", group: "Build", icon: Box },
  { href: "/multi-agent", label: "Multi-Agent", description: "Orchestrate multi-agent flows", group: "Build", icon: Network },
  { href: "/sandbox", label: "Sandbox", description: "Run code in a sandboxed env", group: "Build", icon: Server },
  // Observe
  { href: "/traces", label: "Trace Explorer", description: "Browse and filter traces", group: "Observe", icon: Layers },
  { href: "/replay", label: "Replay", description: "Step through a past trace", group: "Observe", icon: PlayCircle },
  { href: "/observability", label: "Observability", description: "Telemetry overview", group: "Observe", icon: Activity },
  { href: "/observability/apm", label: "APM Tracing", group: "Observe", icon: Gauge },
  { href: "/observability/cohorts", label: "Columnar Engine", group: "Observe", icon: Database },
  { href: "/observability/decisions", label: "Decisions", group: "Observe", icon: GitBranch },
  { href: "/observability/eval", label: "Eval", group: "Observe", icon: BarChart3 },
  { href: "/observability/memory", label: "Memory", group: "Observe", icon: Brain },
  { href: "/observability/query", label: "Query", group: "Observe", icon: Search },
  { href: "/observability/retrieval", label: "Retrieval", group: "Observe", icon: Library },
  { href: "/observability/time-travel", label: "Time-Travel", group: "Observe", icon: History },
  { href: "/tools", label: "Tools", description: "Tool attribution and recommendations", group: "Observe", icon: Wrench },
  { href: "/incidents", label: "Incidents", description: "Open RCA clusters", group: "Observe", icon: Bell },
  { href: "/insights", label: "Insights", description: "Auto-generated intelligence", group: "Observe", icon: Brain },
  { href: "/inspector", label: "Inspector", description: "Debug a specific trace", group: "Observe", icon: Compass },
  { href: "/alerts", label: "Alerts", description: "Active alerts and rules", group: "Observe", icon: Bell },
  { href: "/llmops", label: "LLMOps", description: "LLM observability + judge ops", group: "Observe", icon: Cog },
  { href: "/analytics", label: "Analytics", description: "Token & traffic analytics", group: "Observe", icon: BarChart3 },
  // Optimize
  { href: "/optimization", label: "Cost", description: "Cost overview", group: "Optimize", icon: Sparkles, accent: "accent" },
  { href: "/optimization/outcomes", label: "Outcomes", group: "Optimize", icon: Sparkles },
  { href: "/optimization/predict", label: "Predictive", group: "Optimize", icon: Sparkles },
  { href: "/studio", label: "Custom Metrics", description: "Build custom eval metrics", group: "Optimize", icon: FlaskConical },
  { href: "/guardrails", label: "Guardrails", description: "Active runtime policies", group: "Optimize", icon: Shield },
  // Automate
  { href: "/autonomous", label: "Autonomous", description: "Self-healing code changes", group: "Automate", icon: Wand2 },
  { href: "/closed-loop", label: "Closed-Loop", description: "Auto-improvement loop", group: "Automate", icon: Inbox },
  { href: "/pr-suggestions", label: "PR Suggestions", description: "Suggested code improvements", group: "Automate", icon: GitPullRequestArrow },
  // Admin
  { href: "/settings", label: "Settings", description: "Org + account settings", group: "Admin", icon: Settings },
  { href: "/users", label: "Members", description: "Org members and seats", group: "Admin", icon: Users },
  { href: "/billing", label: "Billing", description: "Plan + payment method", group: "Admin", icon: CreditCard },
  { href: "/profile", label: "Profile", description: "Your profile", group: "Admin", icon: User },
  { href: "/docs", label: "Documentation", description: "API docs and guides", group: "Admin", icon: FileText },
];

const ACCENT_BG: Record<NonNullable<NavEntry["accent"]>, string> = {
  accent: "bg-[var(--accent-faint)] text-[var(--accent)]",
  terminal: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
  muted: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
};

const COMMANDS_BY_HREF = new Map(COMMANDS.map((c) => [c.href, c]));

function readRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(COMMAND_PALETTE_RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeRecent(items: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMMAND_PALETTE_RECENT_KEY, JSON.stringify(items));
  } catch {
    // quota / disabled — fail silently, recent is a nice-to-have
  }
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState("");
  const [recentHrefs, setRecentHrefs] = useState<string[]>([]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }
      // Escape closes the palette from anywhere on the page.
      if (e.key === "Escape" && open) {
        e.preventDefault();
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  // Re-read recent items each time the palette opens.
  useEffect(() => {
    if (open) setRecentHrefs(readRecent());
  }, [open]);

  // Track the current route as recently visited (only for routes the
  // command palette knows about — random 404s shouldn't pollute the list).
  useEffect(() => {
    if (!pathname) return;
    const known = COMMANDS_BY_HREF.get(pathname);
    if (!known) return;
    const recent = readRecent().filter((h) => h !== pathname);
    recent.unshift(pathname);
    const trimmed = recent.slice(0, COMMAND_PALETTE_RECENT_LIMIT);
    writeRecent(trimmed);
    setRecentHrefs(trimmed);
    // pathname is the only signal we care about; the localStorage reads
    // are idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const runCommand = useCallback(
    (path: string) => {
      onOpenChange(false);
      router.push(path);
    },
    [onOpenChange, router],
  );

  // Group commands by their `group` field, preserving the order
  // they were declared in (which mirrors the sidebar).
  const grouped = useMemo(
    () =>
      COMMANDS.reduce<Record<string, NavEntry[]>>((acc, c) => {
        (acc[c.group] = acc[c.group] || []).push(c);
        return acc;
      }, {}),
    [],
  );

  const recentEntries = useMemo(
    () =>
      recentHrefs
        .map((href) => COMMANDS_BY_HREF.get(href))
        .filter((entry): entry is NavEntry => Boolean(entry)),
    [recentHrefs],
  );

  const hasResults = search.trim().length > 0;
  const showFooter = !hasResults;
  const showRecent = recentEntries.length > 0 && !hasResults;

  // Conditionally render the entire tree. The previous version
  // always mounted a ``fixed inset-0 z-50`` wrapper even when
  // ``open === false``; combined with the mobile sidebar overlay
  // and the chat toggle (also ``z-40``/``z-50``), this added an
  // empty full-viewport layer on every page that mounted
  // <CommandPalette />. Returning ``null`` when closed keeps the
  // DOM minimal and removes any chance of an invisible z-50
  // overlay intercepting clicks on the page below.
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div
        className="fixed inset-0 bg-[var(--bg-base)]/40 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <Cmnd
        className={cn(
          "fixed left-1/2 top-[20%] -translate-x-1/2 w-full max-w-[calc(100vw-2rem)] sm:max-w-lg",
          "bg-[var(--bg-primary)] rounded-2xl shadow-2xl border border-[var(--border-default)] overflow-hidden",
          "flex flex-col",
          "animate-scale-in"
        )}
        style={{ maxHeight: "60vh" }}
      >
        <div className="flex items-center gap-3 px-4 border-b border-[var(--border-subtle)]">
          <Search className="w-5 h-5 text-[var(--text-muted)] flex-shrink-0" />
          <Cmnd.Input
            value={search}
            onValueChange={setSearch}
            placeholder="Search pages, observability, settings…"
            className="flex-1 py-4 text-sm outline-none bg-transparent placeholder:text-[var(--text-muted)]"
          />
          <button
            onClick={() => onOpenChange(false)}
            aria-label="Close command palette"
            className="p-1 hover:bg-[var(--bg-tertiary)] rounded transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          >
            <X className="w-4 h-4 text-[var(--text-muted)]" />
          </button>
        </div>

        <Cmnd.List className="flex-1 overflow-y-auto p-2">
          <Cmnd.Empty className="py-6 text-center text-sm text-[var(--text-muted)]">
            No results found.
          </Cmnd.Empty>

          {showRecent && (
            <Cmnd.Group heading="Recent" className="px-2 mt-2 first:mt-0">
              {recentEntries.map((item) => {
                const Icon = item.icon;
                const accentClass = item.accent
                  ? ACCENT_BG[item.accent]
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]";
                return (
                  <Cmnd.Item
                    key={`recent-${item.href}`}
                    value={`${item.label} ${item.href} Recent`}
                    onSelect={() => runCommand(item.href)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
                  >
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", accentClass)}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)]">{item.label}</p>
                      {item.description && (
                        <p className="text-xs text-[var(--text-muted)]">{item.description}</p>
                      )}
                    </div>
                    <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                  </Cmnd.Item>
                );
              })}
            </Cmnd.Group>
          )}

          {Object.entries(grouped).map(([group, items]) => (
            <Cmnd.Group key={group} heading={group} className="px-2 mt-2 first:mt-0">
              {items.map((item) => {
                const Icon = item.icon;
                const accentClass = item.accent
                  ? ACCENT_BG[item.accent]
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]";
                return (
                  <Cmnd.Item
                    key={item.href}
                    value={`${item.label} ${item.href} ${group}`}
                    onSelect={() => runCommand(item.href)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] cursor-pointer transition-colors"
                  >
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", accentClass)}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)]">{item.label}</p>
                      {item.description && (
                        <p className="text-xs text-[var(--text-muted)]">{item.description}</p>
                      )}
                    </div>
                    <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                  </Cmnd.Item>
                );
              })}
            </Cmnd.Group>
          ))}

          {showFooter && (
            <div className="px-4 py-3 border-t border-[var(--border-subtle)] mt-2">
              <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-muted)] font-mono">↑↓</kbd>
                  Navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-muted)] font-mono">↵</kbd>
                  Select
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-muted)] font-mono">Esc</kbd>
                  Close
                </span>
              </div>
            </div>
          )}
        </Cmnd.List>
      </Cmnd>
    </div>
  );
}
