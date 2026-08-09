"use client";

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
  Play,
  Shield,
  Settings,
  PanelLeftClose,
  Tag,
  Layers,
  type LucideIcon,
} from "lucide-react";
import {
  NAV_SECTIONS,
  isNavActive,
  type NavIcon,
  type NavItem,
} from "@/lab/nav";
import { EdenLogo } from "@/components/ds/eden-logo";
import { useSidebar } from "@/components/shell/sidebar-context";
import { SidebarAuthFooter } from "@/components/shell/portal-auth-chrome";
import { AlertsBell } from "@/lab/alerts-bell";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { cn } from "@/lib/utils";

const ICONS: Record<NavIcon, LucideIcon> = {
  home: Home,
  agents: Bot,
  traces: GitBranch,
  issues: AlertTriangle,
  signals: Activity,
  topics: Layers,
  evals: FlaskConical,
  playgrounds: Play,
  improve: Sparkles,
  cost: DollarSign,
  gateway: Network,
  agent: MessageSquare,
  debugger: Bug,
  compare: GitCompare,
  prompts: FileText,
  guardrails: Shield,
  labeling: Tag,
  settings: Settings,
};

function NavLink({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const Icon = ICONS[item.icon];
  const active = isNavActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      data-tour-id={item.id}
      data-active={active ? "true" : "false"}
      data-collapsed={collapsed ? "true" : "false"}
      title={item.label}
      className={cn(
        "type-ui ds-nav-item",
        collapsed && "justify-center !px-0",
      )}
    >
      <Icon
        className={cn(
          "h-[15px] w-[15px] shrink-0",
          active ? "text-[var(--accent)]" : "text-[var(--text-faint)]",
        )}
        strokeWidth={1.6}
        aria-hidden
      />
      <span className={cn(collapsed && "sr-only")}>{item.label}</span>
    </Link>
  );
}

export function SidebarNav() {
  const pathname = usePathname() ?? "";
  const { collapsed, toggle, animate } = useSidebar();

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "group/sidebar hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-[var(--line)] bg-[var(--bg-sidebar)] md:flex",
        animate && "transition-[width] duration-200 ease-out",
        collapsed ? "w-[var(--sidebar-w-collapsed)]" : "w-[var(--sidebar-w)]",
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-b border-[var(--line)]",
          collapsed
            ? "h-auto min-h-[var(--header-h)] flex-col justify-center gap-1.5 px-1 py-2"
            : "h-[var(--header-h)] px-2",
        )}
      >
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <Link
              href="/home"
              className="flex h-8 w-8 items-center justify-center rounded-[var(--radius)] transition-colors hover:bg-[var(--bg-hover)]"
              title="Home"
              aria-label="Home"
            >
              <EdenLogo size={20} />
            </Link>
            <button
              type="button"
              onClick={toggle}
              className="ds-btn ds-btn-ghost ds-btn-icon !h-7 !w-7"
              title="Expand"
              aria-label="Expand navigation"
            >
              <PanelLeftClose className="h-3.5 w-3.5 rotate-180" />
            </button>
            <NotificationsBell collapsed />
            <AlertsBell collapsed />
          </div>
        ) : (
          <>
            <Link
              href="/home"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 transition-colors hover:bg-[var(--bg-hover)]"
            >
              <EdenLogo size={22} />
              <span className="type-title truncate !text-[0.875rem]">eden</span>
            </Link>
            <NotificationsBell />
            <AlertsBell />
            <button
              type="button"
              onClick={toggle}
              className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
              title="Collapse"
              aria-label="Collapse navigation"
              aria-pressed={collapsed}
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      <nav
        className={cn(
          "min-h-0 flex-1 overflow-y-auto py-3",
          collapsed ? "px-1.5" : "px-2.5",
        )}
        aria-label="Primary"
      >
        <ul className="flex flex-col gap-3">
          {NAV_SECTIONS.map((section) => (
            <li key={section.id}>
              {section.label && !collapsed ? (
                <p className="type-label mb-1 px-2.5 text-[var(--text-faint)]">
                  {section.label}
                </p>
              ) : null}
              {section.label && collapsed ? (
                <div
                  className="mx-auto mb-1 h-px w-4 bg-[var(--line)]"
                  aria-hidden
                />
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item.id}>
                    <NavLink
                      item={item}
                      pathname={pathname}
                      collapsed={collapsed}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </nav>

      <SidebarAuthFooter collapsed={collapsed} />
    </aside>
  );
}
