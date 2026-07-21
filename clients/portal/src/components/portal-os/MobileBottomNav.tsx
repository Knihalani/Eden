"use client";

import { useEffect, useState } from "react";
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
  Bot,
  ShieldCheck,
  KeyRound,
  FileCode,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
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

export interface MobileMoreGroup {
  id: string;
  label: string;
  links: MobileNavItem[];
}

/** Wave 1.3 — mobile More Workspace matches desktop Workspace membership. */
export const WS1_MOBILE_WORKSPACE_COMPLETED = true;

/** Wave 3 — same core five as desktop Target IA primary path. */
export const MOBILE_CORE_NAV: MobileNavItem[] = [
  { href: "/dashboard", icon: Home, label: "Home" },
  { href: "/traces", icon: Layers, label: "Traces" },
  { href: "/issues", icon: ShieldAlert, label: "Issues" },
  { href: "/evals", icon: FlaskConical, label: "Evals" },
  { href: "/improve", icon: Sparkles, label: "Improve" },
];

/**
 * More sheet groups — Agents first (UX-P0-14); Workspace last (matches desktop).
 * Flat `MOBILE_MORE_LINKS` is derived for consumers / tests.
 * Promotions nest under Ledger (Wave 3) — no dual mobile entry.
 */
export const MOBILE_MORE_GROUPS: MobileMoreGroup[] = [
  {
    id: "agents",
    label: "Agents",
    links: [{ href: "/agents", icon: Bot, label: "Agents" }],
  },
  {
    id: "ops",
    label: "Ops",
    links: [
      { href: "/artifacts", icon: Package, label: "Artifacts" },
      { href: "/prompts", icon: FileCode, label: "Prompts" },
      { href: "/alerts", icon: Bell, label: "Alerts" },
      { href: "/ledger", icon: ScrollText, label: "Ledger" },
      { href: "/ledger?tab=promotions", icon: TrendingUp, label: "Promotions" },
      { href: "/debugger-sessions", icon: Bug, label: "Debug sessions" },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    links: [
      { href: "/audit-trail", icon: ShieldCheck, label: "Audit trail" },
      { href: "/settings", icon: Settings, label: "Settings" },
      { href: "/settings?tab=api-keys", icon: KeyRound, label: "API keys" },
    ],
  },
];

/** Overflow destinations opened from the More sheet (flat, Agents first). */
export const MOBILE_MORE_LINKS: MobileNavItem[] = MOBILE_MORE_GROUPS.flatMap(
  (g) => g.links,
);

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
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center justify-center min-w-[44px] min-h-[44px] max-w-[4.75rem] gap-1 transition-colors relative rounded-md px-0.5",
        FOCUS_RING_CLASS,
        active ? "text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-[var(--accent)]"
        />
      )}
      <Icon className="w-5 h-5 shrink-0" />
      <span className="text-2xs font-medium max-w-full truncate text-center leading-tight">
        {label}
      </span>
    </Link>
  );
}

export function MobileBottomNav({ items = MOBILE_CORE_NAV }: { items?: MobileNavItem[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [aiRailOpen, setAiRailOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const moreActive = MOBILE_MORE_LINKS.some((l) =>
    isActivePath(pathname, l.href, search),
  );

  // Wave 9 — bottom-layer exclusivity: hide nav while AI rail/sheet claims thumb zone.
  useEffect(() => {
    const sync = () => {
      setAiRailOpen(
        typeof document !== "undefined" &&
          document.documentElement.getAttribute("data-ai-rail-open") === "1",
      );
    };
    sync();
    const onRail = (e: Event) => {
      const open = !!(e as CustomEvent<{ open?: boolean }>).detail?.open;
      setAiRailOpen(open);
    };
    window.addEventListener("eden:ai-rail-open", onRail as EventListener);
    return () =>
      window.removeEventListener("eden:ai-rail-open", onRail as EventListener);
  }, []);

  if (aiRailOpen) return null;

  return (
    <>
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 bg-[var(--bg-primary)] border-t border-[var(--border-default)] z-[var(--z-mobile-nav)] pb-[env(safe-area-inset-bottom,0px)]"
        aria-label="Mobile navigation"
        data-bottom-layer="mobile-nav"
        data-wave11-bottom="exclusive"
        data-wave9-mobile-nav="safe-area"
      >
        <div className="flex items-center justify-around h-16 px-1">
          {items.map((item) => (
            <MobileNavLink key={item.href} {...item} />
          ))}
          <button
            type="button"
            aria-label="More"
            title="More"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
            className={cn(
              "flex flex-col items-center justify-center min-w-[44px] min-h-[44px] max-w-[4.75rem] gap-1 transition-colors relative rounded-md px-0.5",
              FOCUS_RING_CLASS,
              moreActive || moreOpen
                ? "text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
            )}
          >
            <MoreHorizontal className="w-5 h-5 shrink-0" />
            <span className="text-2xs font-medium max-w-full truncate text-center leading-tight">
              More
            </span>
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="lg:hidden">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
            <SheetDescription>
              Agents, ops tools, and workspace settings.
            </SheetDescription>
          </SheetHeader>
          <div className="p-2 space-y-3">
            {MOBILE_MORE_GROUPS.map((group) => (
              <div
                key={group.id}
                {...(group.id === "workspace"
                  ? { "data-ws1-mobile-workspace": true }
                  : {})}
              >
                <p className="px-3 pt-1 pb-1 text-2xs uppercase tracking-wide text-[var(--text-muted)]">
                  {group.label}
                </p>
                <ul className="space-y-1">
                  {group.links.map(({ href, icon: Icon, label }) => (
                    <li key={href}>
                      <Link
                        href={href}
                        onClick={() => setMoreOpen(false)}
                        className={cn(
                          "flex items-center gap-3 min-h-[44px] px-3 py-2 rounded-lg text-sm",
                          FOCUS_RING_CLASS,
                          isActivePath(pathname, href, search)
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
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
