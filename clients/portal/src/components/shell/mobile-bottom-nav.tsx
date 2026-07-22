"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  LayoutDashboard,
  GitBranch,
  ShieldAlert,
  FlaskConical,
  Sparkles,
  MoreHorizontal,
  Bot,
  Bell,
  CircleDollarSign,
  ShieldCheck,
  MessageSquare,
  ScrollText,
  Settings,
  Bug,
  FileText,
  BarChart3,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { MOBILE_BOTTOM_NAV, MOBILE_MORE_NAV } from "@/lib/sidebar-config";
import { cn } from "@/lib/utils";

const BOTTOM_ICONS = {
  dashboard: LayoutDashboard,
  traces: GitBranch,
  issues: ShieldAlert,
  evals: FlaskConical,
  improve: Sparkles,
} as const;

const MORE_ICONS = {
  agents: Bot,
  alerts: Bell,
  cost: CircleDollarSign,
  guardrails: ShieldCheck,
  agent: MessageSquare,
  debugger: Bug,
  prompts: FileText,
  analytics: BarChart3,
  audit: ScrollText,
  settings: Settings,
} as const;

export function MobileBottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [aiRailOpen, setAiRailOpen] = useState(false);
  const tLeaves = useTranslations("nav.leaves");
  const tMobile = useTranslations("mobile");

  // Mutual exclusion with AI bubble (DESIGN-SYSTEM-V2 §6.6).
  useEffect(() => {
    const sync = () => {
      setAiRailOpen(
        document.documentElement.getAttribute("data-ai-rail-open") === "1",
      );
    };
    sync();
    const onRail = (e: Event) => {
      const open = !!(e as CustomEvent<{ open?: boolean }>).detail?.open;
      setAiRailOpen(open);
    };
    window.addEventListener("eden:ai-rail-open", onRail as EventListener);
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-ai-rail-open"],
    });
    return () => {
      window.removeEventListener("eden:ai-rail-open", onRail as EventListener);
      obs.disconnect();
    };
  }, []);

  if (aiRailOpen) return null;

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-[var(--z-mobile-nav)] flex h-16 items-stretch border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] pb-[env(safe-area-inset-bottom)] lg:hidden"
        aria-label={tMobile("ariaLabel")}
        data-mobile-bottom-nav
        data-bottom-layer="mobile-nav"
      >
        {MOBILE_BOTTOM_NAV.map((item) => {
          const Icon = BOTTOM_ICONS[item.id];
          const leafKey = item.id as Parameters<typeof tLeaves>[0];
          const active =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-xs",
                FOCUS_RING_CLASS,
                active
                  ? "text-[var(--accent)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-5 w-5" aria-hidden />
              <span>{tLeaves(leafKey)}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={cn(
            "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            FOCUS_RING_CLASS,
          )}
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden />
          <span>{tMobile("more")}</span>
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="lg:hidden">
          <SheetHeader>
            <SheetTitle>{tMobile("moreTitle")}</SheetTitle>
            <SheetDescription>{tMobile("moreDescription")}</SheetDescription>
          </SheetHeader>
          <ul className="grid gap-1 px-2 pb-4 pt-2">
            {MOBILE_MORE_NAV.map((item) => {
              const Icon = MORE_ICONS[item.id];
              const leafKey = item.id as Parameters<typeof tLeaves>[0];
              return (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
                      FOCUS_RING_CLASS,
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 opacity-80" />
                    {tLeaves(leafKey)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
