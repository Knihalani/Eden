"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { MessageSquare, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openCommandPalette } from "@/components/ui/command-palette";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { useAiSessionContext } from "@/components/ai-agent/ai-session-provider";
import { cn } from "@/lib/utils";

export function PortalHeader() {
  const pathname = usePathname();
  const t = useTranslations("header");
  const tLeaves = useTranslations("nav.leaves");
  const { openAi, showFab } = useAiSessionContext();

  const title = resolveTitle(pathname, tLeaves);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 md:px-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-[var(--text-secondary)]">
          <span className="text-[var(--text-muted)]">{t("breadcrumbHome")}</span>
          <span className="mx-1.5 text-[var(--text-faint)]">/</span>
          <span className="font-medium text-[var(--text-primary)]">{title}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => openCommandPalette()}
          className={cn("gap-1.5", FOCUS_RING_CLASS)}
          aria-keyshortcuts="Meta+K Control+K"
        >
          <Search className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">{t("search")}</span>
          <kbd className="hidden rounded border border-[var(--border-subtle)] px-1 font-mono text-xs text-[var(--text-muted)] md:inline">
            ⌘K
          </kbd>
        </Button>
        {showFab ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("gap-1.5", FOCUS_RING_CLASS)}
            onClick={() => openAi()}
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">{t("ask")}</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function resolveTitle(
  pathname: string,
  tLeaves: ReturnType<typeof useTranslations>,
): string {
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    return tLeaves("dashboard");
  }
  const segments = pathname.split("/").filter(Boolean);
  const leaf = segments[0];
  if (
    leaf &&
    [
      "agents",
      "traces",
      "issues",
      "alerts",
      "evals",
      "improve",
      "guardrails",
      "cost",
      "agent",
      "audit",
      "settings",
      "debugger",
      "prompts",
      "analytics",
    ].includes(leaf)
  ) {
    try {
      return tLeaves(leaf as Parameters<typeof tLeaves>[0]);
    } catch {
      return leaf;
    }
  }
  return tLeaves("dashboard");
}
