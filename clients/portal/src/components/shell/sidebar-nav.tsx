"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { useTranslations } from "next-intl";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

interface SidebarNavProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function SidebarNav({ collapsed, onToggleCollapse }: SidebarNavProps) {
  const pathname = usePathname();
  const tGroups = useTranslations("nav.groups");
  const tLeaves = useTranslations("nav.leaves");
  const tShell = useTranslations("shell");

  return (
    <aside
      className={cn(
        "hidden lg:flex shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] transition-[width] duration-200",
        collapsed ? "w-16" : "w-[240px]",
      )}
      data-collapsed={collapsed || undefined}
    >
      <div
        className={cn(
          "flex h-11 items-center border-b border-[var(--border-subtle)]",
          collapsed ? "justify-center px-2" : "justify-between px-3",
        )}
      >
        {!collapsed ? (
          <Link
            href="/dashboard"
            className={cn(
              "text-sm font-semibold tracking-tight text-[var(--text-primary)]",
              FOCUS_RING_CLASS,
            )}
          >
            {tShell("brand")}
          </Link>
        ) : (
          <Link
            href="/dashboard"
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md text-sm font-semibold text-[var(--accent)]",
              FOCUS_RING_CLASS,
            )}
            aria-label={tShell("brand")}
          >
            E
          </Link>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          aria-label={collapsed ? tShell("expand") : tShell("collapse")}
          className={cn(collapsed && "hidden")}
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
      </div>

      {collapsed ? (
        <div className="flex justify-center border-b border-[var(--border-subtle)] py-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleCollapse}
            aria-label={tShell("expand")}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      <nav
        className="flex-1 overflow-y-auto px-2 py-3"
        aria-label={tShell("navAria")}
      >
        {DEFAULT_SIDEBAR.map((group) => {
          const groupKey = group.id as Parameters<typeof tGroups>[0];
          return (
            <div key={group.id} className="mb-4">
              {!collapsed ? (
                <p className="mb-1 px-2 text-xs font-medium text-[var(--text-muted)]">
                  {tGroups(groupKey)}
                </p>
              ) : null}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const leafKey = item.id as Parameters<typeof tLeaves>[0];
                  const active =
                    pathname === item.href ||
                    (item.href !== "/dashboard" &&
                      pathname.startsWith(item.href));
                  const label = tLeaves(leafKey);
                  return (
                    <li key={item.id}>
                      <Link
                        href={item.href}
                        title={collapsed ? label : undefined}
                        className={cn(
                          "nav-item flex items-center gap-2 rounded-md text-sm transition-colors",
                          collapsed
                            ? "justify-center px-0 py-2"
                            : "px-2 py-1.5",
                          FOCUS_RING_CLASS,
                          active
                            ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
                        )}
                        aria-current={active ? "page" : undefined}
                      >
                        <Icon className="nav-icon h-4 w-4 shrink-0 opacity-80" />
                        {!collapsed ? <span>{label}</span> : null}
                        {collapsed ? (
                          <span className="sr-only">{label}</span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div
        className={cn(
          "border-t border-[var(--border-subtle)] py-3",
          collapsed ? "flex justify-center px-2" : "px-3",
        )}
      >
        <UserButton
          appearance={{
            elements: {
              avatarBox: "h-8 w-8",
            },
          }}
        />
      </div>
    </aside>
  );
}
