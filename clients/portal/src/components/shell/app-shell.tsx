"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { PortalHeader } from "@/components/shell/portal-header";
import { MobileBottomNav } from "@/components/shell/mobile-bottom-nav";
import { CommandPalette } from "@/components/ui/command-palette";
import { useDensity } from "@/components/shell/density-provider";
import { AiBubble } from "@/components/ai-agent/ai-bubble";
import { useAiSessionContext } from "@/components/ai-agent/ai-session-provider";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "eden.sidebar-collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const { density } = useDensity();
  const tShell = useTranslations("shell");
  // toggleAi is owned by AiSessionProvider; bubble + header bind shortcuts.
  const { toggleAi: _toggleAi } = useAiSessionContext();
  void _toggleAi;
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const onToggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <div
      data-density={density}
      className="flex min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]"
    >
      <SidebarNav collapsed={collapsed} onToggleCollapse={onToggleCollapse} />

      <div className="flex min-w-0 flex-1 flex-col">
        <PortalHeader />
        <main className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-4 pb-24 md:px-6 md:py-6 lg:pb-6">
          {children}
        </main>
      </div>

      <MobileBottomNav />
      <CommandPalette />
      <AiBubble />
      <span className="sr-only">{tShell("aiFab")}</span>
    </div>
  );
}
