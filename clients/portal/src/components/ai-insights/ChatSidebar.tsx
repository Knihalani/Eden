"use client";

/**
 * ChatSidebar — persistent right-hand AI assistant (W20 spine + W21 navigate).
 * Logic in ``hooks/useChatSidebar``; UI split into SessionList / MessageList / Composer.
 */

import {
  Plus,
  X,
  PanelRightClose,
  AlertTriangle,
  ChevronDown,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useChatSidebar } from "./hooks/useChatSidebar";
import { SessionList } from "./SessionList";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";

export function ChatSidebar({
  suppressCoach = false,
}: {
  suppressCoach?: boolean;
} = {}) {
  const chat = useChatSidebar();

  if (!chat.f70Enabled) return null;

  const header = (
    <div className="flex items-center justify-between border-b border-[var(--border-default)] px-space-3 py-space-3">
      <div className="relative flex min-w-0 flex-1 items-center gap-space-2">
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
        <button
          type="button"
          onClick={() => chat.setSessionMenuOpen((v) => !v)}
          className="flex min-w-0 items-center gap-space-1 rounded-md px-space-2 py-space-1 text-left hover:bg-[var(--bg-tertiary)]"
          aria-expanded={chat.sessionMenuOpen}
          aria-haspopup="listbox"
          aria-label="Chat sessions"
        >
          <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {chat.sessionLabel}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
        </button>
        <SessionList
          open={chat.sessionMenuOpen}
          loading={chat.loadingSessions}
          error={chat.sessionsError}
          sessions={chat.sessions}
          activeSessionId={chat.activeSessionId}
          onSelect={chat.setActiveSessionId}
          onArchive={chat.archiveSession}
          onRetry={chat.refreshSessions}
          onClose={() => chat.setSessionMenuOpen(false)}
        />
      </div>
      <div className="flex shrink-0 items-center gap-space-1">
        <Button variant="ghost" size="sm" onClick={chat.newChat} aria-label="New chat" className="h-7 w-7 p-0">
          <Plus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => chat.setOpen(false)} aria-label="Close sidebar" className="h-7 w-7 p-0">
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  const body = chat.hasOrg ? (
    <>
      {header}
      <MessageList messages={chat.messages} sessionId={chat.activeSessionId} scrollRef={chat.scrollRef} />
      <Composer
        input={chat.input}
        onInputChange={chat.setInput}
        onSubmit={() => void chat.submit()}
        onStop={chat.stopStreaming}
        streaming={chat.streaming}
        sessionCostUsd={chat.sessionCostUsd}
        costEstimateUsd={chat.costEstimateUsd}
        lastTtftMs={chat.lastTtftMs}
        ttftBudgetMs={chat.ttftBudgetMs}
        ttftWarning={chat.ttftWarning}
      />
    </>
  ) : null;

  const showFab = !chat.hideChatOnRoute && !chat.open && !chat.cookieAwaiting;

  return (
    <>
      {showFab && (
        <div
          className="fixed right-4 z-[var(--z-ai-fab)] bottom-[var(--ai-fab-bottom)] lg:bottom-6 lg:right-6"
          data-ai-fab-host
          data-bottom-layer="ai-fab"
          data-wave9-fab="clear-of-mobile-nav"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  chat.setOpen(true);
                  chat.dismissCoach();
                }}
                className={cn(
                  "z-allow-click gap-1.5 rounded-full px-3 shadow-sm",
                  "border border-[var(--border-default)] text-[var(--text-secondary)]",
                  "hover:border-[var(--accent)]/40 hover:text-[var(--accent)]",
                )}
                aria-label="Ask AI"
                data-ai-fab
                data-ai-coach-anchor
              >
                <MessageSquare className="h-4 w-4 text-[var(--accent)]" aria-hidden />
                <span className="text-xs font-medium">Ask AI</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[240px] text-xs">
              Ask AI — header icon, this button, or ⌘K / ⌘J
            </TooltipContent>
          </Tooltip>

          {chat.showCoach && !suppressCoach && !chat.isMobile && (
            <div
              role="status"
              data-ai-coach-mark
              className={cn(
                "absolute bottom-12 right-0 w-56 rounded-md border",
                "border-[var(--accent)]/40 bg-[var(--bg-primary)] p-space-3 text-xs shadow-lg",
                "text-[var(--text-secondary)]",
              )}
            >
              <p className="font-medium text-[var(--text-primary)]">Ask Eden AI</p>
              <p className="mt-space-1 leading-snug">
                Open from the header Ask AI icon, this button, or ⌘K. Filter
                lists, find similar traces, and jump to issues. Try{" "}
                <span className="font-mono text-[var(--accent)]">/filter</span> or{" "}
                <span className="font-mono text-[var(--accent)]">/go</span>.
              </p>
              <button
                type="button"
                className="mt-space-2 text-xs font-medium text-[var(--accent)] hover:underline"
                onClick={chat.dismissCoach}
              >
                Got it
              </button>
            </div>
          )}
        </div>
      )}

      {chat.isMobile && chat.hasOrg && (
        <Sheet open={chat.open} onOpenChange={chat.setOpen}>
          <SheetContent
            side="right"
            className="flex w-full max-w-full flex-col p-0 sm:max-w-md"
            aria-label="AI Insights assistant"
            data-bottom-layer="ai-sheet"
            data-wave9-ai="exclusive"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>AI Insights assistant</SheetTitle>
            </SheetHeader>
            {body}
          </SheetContent>
        </Sheet>
      )}

      {!chat.isMobile && chat.open && chat.hasOrg && (
        <aside
          ref={chat.panelRef as React.RefObject<HTMLElement>}
          className={cn(
            "fixed right-0 top-0 z-[var(--z-ai-rail)] flex h-dvh flex-col",
            "border-l border-[var(--border-default)] bg-[var(--bg-primary)]",
            "shadow-xl lg:shadow-none w-[min(100vw,360px)]",
          )}
          role="complementary"
          aria-label="AI Insights assistant"
          data-ai-rail
          data-bottom-layer="ai-rail"
          data-wave9-ai="exclusive"
        >
          {body}
        </aside>
      )}

      {!chat.hasOrg && chat.open && (
        <div className="fixed right-4 z-50 max-w-xs rounded-md border border-[var(--warning)]/40 bg-[var(--bg-primary)] p-space-3 text-xs text-[var(--text-secondary)] shadow-lg bottom-[var(--ai-fab-bottom)] lg:bottom-4">
          <div className="flex items-start gap-space-2">
            <AlertTriangle className="h-4 w-4 text-[var(--warning)]" />
            <div>Select a workspace from the sidebar to use AI Insights.</div>
            <button type="button" onClick={() => chat.setOpen(false)} className="ml-auto text-[var(--text-muted)]" aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
