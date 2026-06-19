"use client";

import { useState, useEffect } from "react";
import { Command as Cmnd } from "cmdk";
import { useRouter } from "next/navigation";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  { href: "/observability/apm", label: "APM Tracing", group: "Observe", icon: Activity },
  { href: "/observability/cohorts", label: "Columnar Engine", group: "Observe", icon: Activity },
  { href: "/observability/decisions", label: "Decisions", group: "Observe", icon: Activity },
  { href: "/observability/eval", label: "Eval", group: "Observe", icon: Activity },
  { href: "/observability/memory", label: "Memory", group: "Observe", icon: Activity },
  { href: "/observability/query", label: "Query", group: "Observe", icon: Activity },
  { href: "/observability/retrieval", label: "Retrieval", group: "Observe", icon: Activity },
  { href: "/observability/time-travel", label: "Time-Travel", group: "Observe", icon: Activity },
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

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  const runCommand = (path: string) => {
    onOpenChange(false);
    router.push(path);
  };

  // Group commands by their `group` field, preserving the order
  // they were declared in (which mirrors the sidebar).
  const grouped = COMMANDS.reduce<Record<string, NavEntry[]>>((acc, c) => {
    (acc[c.group] = acc[c.group] || []).push(c);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-50">
      {open && (
        <div
          className="fixed inset-0 bg-[var(--bg-base)]/40 backdrop-blur-sm"
          onClick={() => onOpenChange(false)}
        />
      )}
      <Cmnd
        className={cn(
          "fixed left-1/2 top-[20%] -translate-x-1/2 w-full max-w-lg",
          "bg-[var(--bg-primary)] rounded-2xl shadow-2xl border border-[var(--border-default)] overflow-hidden",
          "flex flex-col",
          open ? "animate-scale-in" : "hidden"
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
            className="p-1 hover:bg-[var(--bg-tertiary)] rounded transition-colors"
          >
            <X className="w-4 h-4 text-[var(--text-muted)]" />
          </button>
        </div>

        <Cmnd.List className="flex-1 overflow-y-auto p-2">
          <Cmnd.Empty className="py-6 text-center text-sm text-[var(--text-muted)]">
            No results found.
          </Cmnd.Empty>

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
        </Cmnd.List>
      </Cmnd>
    </div>
  );
}
