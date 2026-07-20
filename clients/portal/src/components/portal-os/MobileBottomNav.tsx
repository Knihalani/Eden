"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Home,
  Layers,
  ShieldAlert,
  Sparkles,
  MoreHorizontal,
  Package,
  Bell,
  FlaskConical,
  Settings,
  ScrollText,
  TrendingUp,
  Bug,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export interface MobileNavItem {
  href: string;
  icon: LucideIcon;
  label: string;
}

/** U18 locked mobile IA — 4 core + More sheet. */
export const MOBILE_CORE_NAV: MobileNavItem[] = [
  { href: "/dashboard", icon: Home, label: "Home" },
  { href: "/traces", icon: Layers, label: "Traces" },
  { href: "/issues", icon: ShieldAlert, label: "Issues" },
  { href: "/improve", icon: Sparkles, label: "Improve" },
];

/** Overflow destinations opened from the More sheet. */
export const MOBILE_MORE_LINKS: MobileNavItem[] = [
  { href: "/artifacts", icon: Package, label: "Artifacts" },
  { href: "/alerts", icon: Bell, label: "Alerts" },
  { href: "/evals", icon: FlaskConical, label: "Evals" },
  { href: "/ledger", icon: ScrollText, label: "Ledger" },
  { href: "/promotions", icon: TrendingUp, label: "Promotions" },
  { href: "/debugger-sessions", icon: Bug, label: "Debug sessions" },
  { href: "/settings", icon: Settings, label: "Settings" },
];

function isActivePath(pathname: string, href: string, search?: string): boolean {
  if (!pathname || !href) return false;
  const [pathOnly, queryPart] = href.split("?", 2);
  if (pathOnly === "/dashboard") return pathname === "/dashboard";
  const pathMatch =
    pathname === pathOnly || pathname.startsWith(pathOnly + "/");
  if (!pathMatch) return false;
  const currentTab = new URLSearchParams(search || "").get("tab");
  if (!queryPart) {
    // Bare path = default tab; inactive when a sibling ?tab= is set.
    return !currentTab;
  }
  const expectedTab = new URLSearchParams(queryPart).get("tab");
  if (!expectedTab) return true;
  return currentTab === expectedTab;
}

function MobileNavLink({ href, icon: Icon, label }: MobileNavItem) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = isActivePath(pathname, href, searchParams.toString());

  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center justify-center min-w-[44px] min-h-[44px] gap-1 transition-colors relative",
        active ? "text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-[var(--accent)]"
        />
      )}
      <Icon className="w-5 h-5" />
      <span className="text-[10px] font-medium">{label}</span>
    </Link>
  );
}

export function MobileBottomNav({ items = MOBILE_CORE_NAV }: { items?: MobileNavItem[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = usePathname();
  const moreActive = MOBILE_MORE_LINKS.some((l) =>
    isActivePath(pathname, l.href),
  );

  return (
    <>
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 bg-[var(--bg-primary)] border-t border-[var(--border-default)] z-40 pb-[env(safe-area-inset-bottom)]"
        aria-label="Mobile navigation"
      >
        <div className="flex items-center justify-around h-16 px-1">
          {items.map((item) => (
            <MobileNavLink key={item.href} {...item} />
          ))}
          <button
            type="button"
            aria-label="More"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
            className={cn(
              "flex flex-col items-center justify-center min-w-[44px] min-h-[44px] gap-1 transition-colors relative",
              moreActive || moreOpen
                ? "text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
            )}
          >
            <MoreHorizontal className="w-5 h-5" />
            <span className="text-[10px] font-medium">More</span>
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="lg:hidden">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
            <SheetDescription>Artifacts, alerts, evals, ledger, and more.</SheetDescription>
          </SheetHeader>
          <ul className="p-2 space-y-1">
            {MOBILE_MORE_LINKS.map(({ href, icon: Icon, label }) => (
              <li key={href}>
                <Link
                  href={href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex items-center gap-3 min-h-[44px] px-3 py-2 rounded-lg text-sm",
                    isActivePath(pathname, href)
                      ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                      : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]",
                  )}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
