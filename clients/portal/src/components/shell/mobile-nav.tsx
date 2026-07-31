"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Bot,
  GitBranch,
  AlertTriangle,
  Activity,
  FlaskConical,
  Sparkles,
  DollarSign,
  Network,
  MessageSquare,
  Bug,
  GitCompare,
  FileText,
  Shield,
  Settings,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import {
  NAV_SECTIONS,
  PRIMARY_NAV,
  isNavActive,
  type NavIcon,
  type NavItem,
} from "@/lab/nav";
import { cn } from "@/lib/utils";

const ICONS: Record<NavIcon, LucideIcon> = {
  home: Home,
  agents: Bot,
  traces: GitBranch,
  issues: AlertTriangle,
  signals: Activity,
  evals: FlaskConical,
  improve: Sparkles,
  cost: DollarSign,
  gateway: Network,
  agent: MessageSquare,
  debugger: Bug,
  compare: GitCompare,
  prompts: FileText,
  guardrails: Shield,
  settings: Settings,
};

/** Five primary hubs on the bottom bar — mirrors product IA. */
const BOTTOM_IDS = new Set(["home", "traces", "issues", "evals", "improve"]);

const BOTTOM_ITEMS: NavItem[] = PRIMARY_NAV.filter((i) => BOTTOM_IDS.has(i.id));

const MORE_ITEMS: NavItem[] = PRIMARY_NAV.filter((i) => !BOTTOM_IDS.has(i.id));

export function MobileBottomNav() {
  const pathname = usePathname() ?? "";
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE_ITEMS.some((i) => isNavActive(pathname, i.href));

  return (
    <>
      {moreOpen ? (
        <div
          className="fixed inset-0 z-[60] md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="More navigation"
        >
          <button
            type="button"
            className="absolute inset-0 bg-[var(--scrim)]"
            aria-label="Close more navigation"
            onClick={() => setMoreOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] mx-3 max-h-[60dvh] overflow-auto rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-elevated)] p-3 shadow-lg">
            {NAV_SECTIONS.map((section) => {
              const items = section.items.filter((i) => !BOTTOM_IDS.has(i.id));
              if (items.length === 0) return null;
              return (
                <div key={section.id} className="mb-3 last:mb-0">
                  {section.label ? (
                    <p className="type-meta mb-1.5 px-2 text-[var(--text-faint)]">
                      {section.label}
                    </p>
                  ) : null}
                  <ul className="flex flex-col gap-0.5">
                    {items.map((item) => {
                      const Icon = ICONS[item.icon];
                      const active = isNavActive(pathname, item.href);
                      return (
                        <li key={item.id}>
                          <Link
                            href={item.href}
                            onClick={() => setMoreOpen(false)}
                            data-active={active ? "true" : "false"}
                            className={cn(
                              "type-ui flex items-center gap-2 rounded-[var(--radius)] px-2 py-2.5",
                              active
                                ? "bg-[var(--bg-inset)] text-[var(--accent)]"
                                : "text-[var(--text)]",
                            )}
                          >
                            <Icon className="h-4 w-4 shrink-0" strokeWidth={1.6} aria-hidden />
                            {item.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <nav
        aria-label="Mobile"
        className="fixed inset-x-0 bottom-0 z-50 flex h-14 items-stretch border-t border-[var(--line)] bg-[var(--bg-sidebar)] pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {BOTTOM_ITEMS.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isNavActive(pathname, item.href);
          return (
            <Link
              key={item.id}
              href={item.href}
              data-active={active ? "true" : "false"}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 type-meta",
                active ? "text-[var(--accent)]" : "text-[var(--text-faint)]",
              )}
            >
              <Icon className="h-4 w-4" strokeWidth={1.6} aria-hidden />
              <span className="truncate max-w-full px-0.5">{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          aria-label="More"
          data-active={moreActive || moreOpen ? "true" : "false"}
          className={cn(
            "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 type-meta",
            moreActive || moreOpen
              ? "text-[var(--accent)]"
              : "text-[var(--text-faint)]",
          )}
        >
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.6} aria-hidden />
          <span>More</span>
        </button>
      </nav>
    </>
  );
}
