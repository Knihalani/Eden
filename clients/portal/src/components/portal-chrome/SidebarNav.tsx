"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { OrganizationSwitcher } from "@clerk/nextjs";
import {
  Building2,
  CreditCard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  X,
} from "lucide-react";
import type { SidebarGroup } from "@/lib/sidebar-config";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { NavGroup, NavItem, NavSubItem } from "./sidebar-nav-items";

const BudgetTicker = dynamic(
  () =>
    import("@/components/budget-ticker").then((m) => ({
      default: m.BudgetTicker,
    })),
  { ssr: false },
);

export const SIDEBAR_EXPANDED_WIDTH = 240;
export const SIDEBAR_COLLAPSED_WIDTH = 64;
export const COLLAPSE_STORAGE_KEY = "eden:sidebar:collapsed";

/** Read collapsed preference from localStorage (SSR-safe → false). */
export function readCollapsedPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export type SidebarNavItem = SidebarGroup["items"][number];

export interface SidebarNavProps {
  collapsed: boolean;
  sidebarOpen: boolean;
  /** Narrow viewport + drawer open — controls overlay / dialog a11y. */
  mobileDrawerOpen: boolean;
  advancedCollapsed: boolean;
  densityCompact: boolean;
  /** True while product tour overlay is open — demotes mobile drawer modal. */
  tourSpotlightActive: boolean;
  pinnedItems: SidebarNavItem[];
  groups: SidebarGroup[];
  /** Prefs pinned ids for isPinned checks in group items. */
  prefsPinned: string[];
  onTogglePin: (id: string) => void;
  onToggleAdvanced: () => void;
  onCollapse: () => void;
  onCloseMobileDrawer: () => void;
  user: { name: string; email: string };
  userDropdownOpen: boolean;
  setUserDropdownOpen: Dispatch<SetStateAction<boolean>>;
  userDropdownRef: RefObject<HTMLDivElement | null>;
  sidebarCloseRef: RefObject<HTMLButtonElement | null>;
  sidebarAsideRef: RefObject<HTMLElement | null>;
  onLogout: () => void;
}

export function SidebarNav({
  collapsed,
  sidebarOpen,
  mobileDrawerOpen,
  advancedCollapsed,
  densityCompact,
  tourSpotlightActive,
  pinnedItems,
  groups,
  prefsPinned,
  onTogglePin,
  onToggleAdvanced,
  onCollapse,
  onCloseMobileDrawer,
  user,
  userDropdownOpen,
  setUserDropdownOpen,
  userDropdownRef,
  sidebarCloseRef,
  sidebarAsideRef,
  onLogout,
}: SidebarNavProps) {
  return (
    <>
      {mobileDrawerOpen && (
        <div
          role="presentation"
          aria-hidden="true"
          className="fixed inset-0 bg-[var(--bg-base)]/50 z-40 lg:hidden cursor-default"
          onClick={onCloseMobileDrawer}
        />
      )}

      <aside
        ref={sidebarAsideRef}
        id="portal-sidebar"
        aria-label="Main navigation"
        role={mobileDrawerOpen && !tourSpotlightActive ? "dialog" : undefined}
        aria-modal={mobileDrawerOpen && !tourSpotlightActive ? true : undefined}
        data-home-shell-sidebar="tonal-rail"
        className={cn(
          "sidebar flex flex-col relative bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] z-50",
          "fixed inset-y-0 left-0 lg:sticky lg:top-0 lg:self-start lg:h-dvh lg:flex-shrink-0",
          collapsed ? "collapsed" : "",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          "transition-[transform,width] duration-300 ease-out lg:transition-[width]",
          "motion-reduce:transition-none",
        )}
        style={{
          width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH,
        }}
      >
        <div className="absolute inset-0 sidebar-gradient pointer-events-none" />

        <div
          className={cn(
            "relative flex items-center border-b border-[var(--border-subtle)] shrink-0 h-12",
            collapsed ? "justify-center px-0" : "justify-between gap-1 px-3",
          )}
        >
          <Link
            href="/dashboard"
            className="min-w-0 flex items-center hover:opacity-80 transition-opacity"
            aria-label="Eden home"
          >
            <Logo size="md" showWordmark={!collapsed} priority href={null} className="min-w-0" />
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onCollapse}
            className={cn(
              "hidden md:inline-flex",
              "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
            )}
            aria-label={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
            title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
          >
            {collapsed ? (
              <PanelLeftOpen className="w-3.5 h-3.5" />
            ) : (
              <PanelLeftClose className="w-3.5 h-3.5" />
            )}
          </Button>
          <Button
            ref={sidebarCloseRef}
            id="portal-sidebar-close"
            type="button"
            variant="ghost"
            size="icon"
            onClick={onCloseMobileDrawer}
            className="lg:hidden text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Org switcher — utility calm; no competing CTA chrome. */}
        <div
          className={cn(
            "relative pb-2 pt-2",
            collapsed ? "px-1.5 flex justify-center" : "px-2.5",
          )}
        >
          <OrganizationSwitcher
            hidePersonal
            afterSelectOrganizationUrl="/dashboard"
            appearance={{
              elements: {
                rootBox: collapsed ? "w-10" : "w-full",
                organizationSwitcherTrigger: collapsed
                  ? "w-10 h-10 min-h-11 justify-center rounded-md border-0 bg-transparent p-0 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  : "w-full justify-between rounded-md border-0 bg-transparent px-2 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
                organizationPreviewTextContainer: collapsed ? "hidden" : undefined,
                organizationSwitcherTriggerIcon: collapsed
                  ? "hidden"
                  : "text-[var(--text-muted)]",
              },
            }}
          />
        </div>

        <nav
          className={cn(
            "relative flex-1 min-h-0 overflow-y-auto overscroll-contain",
            densityCompact ? "px-1.5 py-1.5 space-y-2" : "px-2 py-2 space-y-3",
          )}
          aria-label="Main navigation"
        >
          {pinnedItems.length > 0 && (
            <NavGroup label="Pinned" collapsed={collapsed} quiet>
              {pinnedItems.map((item) => (
                <NavItem
                  key={item.id}
                  tourId={item.id}
                  href={item.href}
                  icon={item.icon}
                  label={item.label}
                  description={item.description}
                  collapsed={collapsed}
                  compact={densityCompact}
                  onClick={onCloseMobileDrawer}
                  pinned
                  onTogglePin={() => onTogglePin(item.id)}
                />
              ))}
            </NavGroup>
          )}

          {groups.map((group) => (
            <NavGroup key={group.id} label={group.label} collapsed={collapsed}>
              {group.items.map((item) => {
                const isPinned = prefsPinned.includes(item.id);
                return (
                  <NavItem
                    key={item.id}
                    tourId={item.id}
                    href={item.href}
                    icon={item.icon}
                    label={item.label}
                    description={item.description}
                    badge={item.badge}
                    collapsed={collapsed}
                    compact={densityCompact}
                    onClick={onCloseMobileDrawer}
                    pinned={isPinned}
                    onTogglePin={() => onTogglePin(item.id)}
                  >
                    {item.children?.map((child) => (
                      <NavSubItem
                        key={child.id}
                        tourId={child.id}
                        href={child.href}
                        label={child.label}
                        description={child.description}
                        compact={densityCompact}
                        onClick={onCloseMobileDrawer}
                      />
                    ))}
                  </NavItem>
                );
              })}
            </NavGroup>
          ))}

          {!collapsed && (
            <div className="pt-1 space-y-0.5">
              <Link
                href="/settings?tab=sidebar"
                className="flex items-center px-2.5 py-1.5 text-2xs text-[var(--text-muted)]/70 hover:text-[var(--text-muted)] rounded-md transition-colors"
              >
                Customize
              </Link>
              <Button
                type="button"
                variant="ghost"
                onClick={onToggleAdvanced}
                aria-pressed={!advancedCollapsed}
                className="flex h-auto w-full items-center justify-between gap-2 px-2.5 py-1.5 min-h-9 text-2xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                title={
                  advancedCollapsed
                    ? "Show Advanced (Agents, Analytics, Cost…)"
                    : "Hide Advanced surfaces"
                }
              >
                <span>{advancedCollapsed ? "Show Advanced" : "Hide Advanced"}</span>
                <span
                  className={cn(
                    "w-7 h-3.5 rounded-full p-0.5 transition-colors motion-reduce:transition-none",
                    advancedCollapsed
                      ? "bg-[var(--bg-tertiary)]"
                      : "bg-[var(--border-default)]",
                  )}
                >
                  <span
                    className={cn(
                      "block w-2.5 h-2.5 rounded-full bg-[var(--text-muted)] transition-transform motion-reduce:transition-none",
                      advancedCollapsed ? "translate-x-0" : "translate-x-3.5 bg-[var(--text-primary)]",
                    )}
                  />
                </span>
              </Button>
            </div>
          )}
        </nav>

        <div className="relative mt-auto border-t border-[var(--border-subtle)] shrink-0">
          {!collapsed && (
            <div className="px-2.5 pt-2">
              <BudgetTicker />
            </div>
          )}
          <div className="p-2">
            <div ref={userDropdownRef} className="relative">
              <button
                type="button"
                onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                className={cn(
                  "w-full flex items-center gap-2.5 p-1.5 rounded-md transition-colors",
                  collapsed && "justify-center",
                  userDropdownOpen
                    ? "bg-[var(--bg-tertiary)]"
                    : "hover:bg-[var(--bg-tertiary)]",
                )}
                aria-expanded={userDropdownOpen}
                aria-haspopup="true"
                aria-label="User menu"
                title={collapsed ? `${user.name} · ${user.email}` : undefined}
              >
                <div className="user-avatar user-avatar-online w-8 h-8 rounded-full flex items-center justify-center text-xs flex-shrink-0">
                  {user.name.charAt(0).toUpperCase()}
                </div>
                {!collapsed && (
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate leading-tight">
                      {user.name}
                    </p>
                    <p className="text-2xs text-[var(--text-muted)] truncate">{user.email}</p>
                  </div>
                )}
              </button>

              <div
                className={cn("user-dropdown", userDropdownOpen ? "open" : "")}
                role="menu"
                aria-label="User menu"
              >
                <Link
                  href="/settings?tab=org"
                  className="user-dropdown-item"
                  onClick={() => setUserDropdownOpen(false)}
                >
                  <Building2 className="w-4 h-4" />
                  Workspace
                </Link>
                <Link
                  href="/settings"
                  className="user-dropdown-item"
                  onClick={() => setUserDropdownOpen(false)}
                >
                  <Settings className="w-4 h-4" />
                  Settings
                </Link>
                <Link
                  href="/settings?tab=billing"
                  className="user-dropdown-item"
                  onClick={() => setUserDropdownOpen(false)}
                >
                  <CreditCard className="w-4 h-4" />
                  Billing
                </Link>
                <button
                  type="button"
                  onClick={onLogout}
                  className="user-dropdown-item danger w-full"
                  role="menuitem"
                >
                  <LogOut className="w-4 h-4" />
                  Log out
                </button>
              </div>
            </div>

            {collapsed && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onLogout}
                className="mt-1.5 w-full text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-bg)]"
                aria-label="Log out"
              >
                <LogOut className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
