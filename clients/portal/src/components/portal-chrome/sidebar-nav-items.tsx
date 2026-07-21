"use client";

import type { ComponentType, ReactNode } from "react";
import { Pin } from "lucide-react";
import { cn, isExternalHref } from "@/lib/utils";
import { usePathname, useSearchParams } from "next/navigation";
import { PortalNavLink } from "@/components/layout/portal-nav-link";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export function isActivePath(pathname: string, href: string, search?: string): boolean {
  if (!pathname || !href) return false;
  const [pathOnly, queryPart] = href.split("?", 2);
  // Dashboard is root — exact match only (never sticky on sub-routes).
  if (pathOnly === "/dashboard") return pathname === "/dashboard";
  const pathMatch =
    pathname === pathOnly || pathname.startsWith(pathOnly + "/");
  if (!pathMatch) return false;
  const currentTab = new URLSearchParams(search || "").get("tab");
  if (!queryPart) {
    // Bare path = default tab. Stay inactive when a sibling ?tab= is set.
    return !currentTab;
  }
  const expectedTab = new URLSearchParams(queryPart).get("tab");
  if (!expectedTab) return true;
  return currentTab === expectedTab;
}

export function NavSubItem({
  tourId,
  href,
  label,
  description,
  compact,
  onClick }: {
  tourId?: string;
  href: string;
  label: string;
  description?: string;
  compact?: boolean;
  onClick?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = !isExternalHref(href) && isActivePath(pathname, href, searchParams.toString());
  const link = (
    <PortalNavLink
      href={href}
      onClick={onClick}
      data-tour-id={tourId || undefined}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "nav-subitem block pl-9 pr-3 rounded-md text-xs font-medium transition-colors motion-reduce:transition-none relative",
        compact ? "py-1" : "py-1.5",
        active
          ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)]"
          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/70",
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-[var(--accent)]"
        />
      )}
      <span className="truncate">{label}</span>
    </PortalNavLink>
  );
  if (!description) return link;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={6} className="max-w-[240px]">
        <div className="font-medium text-[var(--text-primary)]">{label}</div>
        <div className="mt-0.5 text-xs text-[var(--text-secondary)] leading-snug">
          {description}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function NavItem({
  tourId,
  href,
  icon: Icon,
  label,
  description,
  collapsed,
  compact,
  onClick,
  children,
  badge,
  pinned,
  onTogglePin }: {
  tourId?: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  description?: string;
  collapsed: boolean;
  compact?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  badge?: string;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const external = isExternalHref(href);
  const active = !external && isActivePath(pathname, href, searchParams.toString());
  const hasChildren = !collapsed && children;

  return (
    <div className="group/navitem relative" data-tour-id={tourId || undefined}>
      {(() => {
        const link = (
          <PortalNavLink
            href={href}
            onClick={onClick}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            showExternalIcon={external && !collapsed}
            className={cn(
              "nav-item flex items-center gap-2.5 px-2.5 rounded-md text-sm transition-colors duration-150 motion-reduce:transition-none relative",
              compact ? "py-1.5 min-h-8" : "py-2 min-h-9",
              onTogglePin && !collapsed && "pr-8",
              active
                ? "font-medium text-[var(--text-primary)] bg-[var(--bg-tertiary)]"
                : "font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/70",
            )}
          >
            {/* Active = one --accent tick (Helicone-class). Fill is tonal only. */}
            {active && (
              <span
                aria-hidden="true"
                className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-[var(--accent)]"
              />
            )}
            <Icon
              className={cn(
                "flex-shrink-0 nav-icon transition-colors duration-150 motion-reduce:transition-none",
                compact ? "w-3.5 h-3.5" : "w-4 h-4",
                active ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]",
              )}
            />
            {!collapsed && (
              <>
                <span className="truncate flex-1 leading-none">{label}</span>
                {badge && (
                  <span className="px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider rounded bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                    {badge}
                  </span>
                )}
              </>
            )}
          </PortalNavLink>
        );
        const pinControl =
          onTogglePin && !collapsed ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onTogglePin();
              }}
              aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
              aria-pressed={pinned}
              className={cn(
                "pin-button absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6 min-h-6 min-w-6 p-1",
                pinned
                  ? "text-[var(--text-muted)] opacity-70"
                  : "text-[var(--text-muted)] opacity-0 group-hover/navitem:opacity-60 hover:opacity-100 hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
              )}
              title={pinned ? "Unpin from sidebar" : "Pin to top of sidebar"}
            >
              <Pin className={cn("w-3 h-3", pinned && "fill-current")} />
            </Button>
          ) : null;
        const linkWithPin = (
          <div className="relative">
            {description ? (
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="max-w-[260px]">
                  <div className="font-medium text-[var(--text-primary)]">{label}</div>
                  <div className="mt-0.5 text-xs text-[var(--text-secondary)] leading-snug">
                    {description}
                  </div>
                </TooltipContent>
              </Tooltip>
            ) : collapsed ? (
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
              </Tooltip>
            ) : (
              link
            )}
            {pinControl}
          </div>
        );
        return linkWithPin;
      })()}
      {hasChildren && (
        <div className="mt-0.5 space-y-0.5">{children}</div>
      )}
    </div>
  );
}

export function NavGroup({
  label,
  collapsed,
  quiet,
  children }: {
  label: string;
  collapsed: boolean;
  /** Quieter section label (Pinned). */
  quiet?: boolean;
  children: ReactNode;
}) {
  if (collapsed) {
    return (
      <div className="space-y-0.5 border-t border-[var(--border-subtle)] pt-2 first:border-t-0 first:pt-0">
        {children}
      </div>
    );
  }
  return (
    <div className={cn("space-y-0.5", quiet && "opacity-90")}>
      <div
        className={cn(
          "px-2.5 pt-1 pb-0.5 text-2xs font-mono font-medium uppercase tracking-[0.12em]",
          quiet ? "text-[var(--text-muted)]/60" : "text-[var(--text-muted)]/75",
        )}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
