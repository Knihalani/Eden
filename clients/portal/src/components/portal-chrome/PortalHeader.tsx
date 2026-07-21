"use client";

import type { RefObject } from "react";
import { Menu, Search, MessageSquare } from "lucide-react";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { Breadcrumb as BreadcrumbCrumb } from "@/lib/breadcrumbs";
import { NotificationsDropdown } from "./NotificationsDropdown";

export interface PortalHeaderProps {
  breadcrumbs: BreadcrumbCrumb[];
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onOpenCommandPalette: () => void;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
}

function openAskAi() {
  window.dispatchEvent(new CustomEvent("eden:ask-ai"));
}

/**
 * Sticky shell location band (h-11).
 * Location = kit breadcrumb only; page title lives in PageHeader.
 * Utility strip (L→R): Search…⌘K · Ask AI · Notifications (1A).
 * Controls = kit Button only (W6).
 */
export function PortalHeader({
  breadcrumbs,
  sidebarOpen,
  onOpenSidebar,
  onOpenCommandPalette,
  menuButtonRef,
}: PortalHeaderProps) {
  return (
    <header
      className="sticky top-0 z-30 bg-[var(--bg-primary)]/95 backdrop-blur-sm border-b border-[var(--border-subtle)]"
      data-home-shell-header="slim"
    >
      <div className="flex items-center justify-between h-11 px-space-4 sm:px-space-5 lg:px-space-7 gap-space-3">
        <div className="flex items-center gap-3 lg:hidden">
          <Button
            ref={menuButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            onClick={onOpenSidebar}
            className="text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] active:bg-[var(--border-default)]"
            aria-label="Open menu"
            aria-expanded={sidebarOpen}
            aria-controls="portal-sidebar"
            aria-haspopup="dialog"
          >
            <Menu className="w-5 h-5" />
          </Button>
          <Link
            href="/dashboard"
            className="inline-flex items-center hover:opacity-80 transition-opacity"
            aria-label="Eden home"
          >
            <Logo size="sm" showWordmark={false} priority href={null} />
          </Link>
        </div>

        <Breadcrumb
          items={breadcrumbs}
          className="flex-1 lg:flex-initial"
          homeHref="/dashboard"
          collapseDeep
          showCategoryPrefix
        />

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onOpenCommandPalette}
            className="hidden lg:inline-flex h-8 gap-2 px-2.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]"
            title="Search (⌘K)"
            aria-label="Search (⌘K)"
            data-search-chip
          >
            <Search className="w-3.5 h-3.5" />
            <span>Search…</span>
            <kbd className="ml-0.5 px-1 py-0.5 border border-[var(--border-subtle)] rounded text-[var(--text-muted)] font-mono text-2xs">
              ⌘K
            </kbd>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onOpenCommandPalette}
                className="lg:hidden text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] active:bg-[var(--border-default)]"
                aria-label="Search (⌘K)"
                data-search-icon
              >
                <Search className="w-5 h-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Search… · <kbd className="font-mono">⌘K</kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={openAskAi}
                className="text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)]"
                aria-label="Ask AI"
                data-ask-ai-header
              >
                <MessageSquare className="w-4 h-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Ask AI · <kbd className="font-mono">⌘J</kbd>
            </TooltipContent>
          </Tooltip>
          <NotificationsDropdown />
        </div>
      </div>
    </header>
  );
}
