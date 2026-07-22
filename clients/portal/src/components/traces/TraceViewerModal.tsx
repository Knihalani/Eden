"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Copy, Check, X } from "lucide-react";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { isFocusInTranscript } from "@/hooks/use-list-keyboard-nav";

export interface TraceViewerModalProps {
  open: boolean;
  onClose: () => void;
  traceId: string;
  /** Primary title (agent / model / truncated id). */
  title?: React.ReactNode;
  outcome?: string | null;
  onPrev?: () => void;
  onNext?: () => void;
  children: React.ReactNode;
  className?: string;
}

/**
 * Near-fullscreen trace viewer (Radix Dialog).
 * List stays mounted underneath; Esc / backdrop / Close clear selection.
 */
export function TraceViewerModal({
  open,
  onClose,
  traceId,
  title,
  outcome,
  onPrev,
  onNext,
  children,
  className,
}: TraceViewerModalProps) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isFormField) return;
      // Esc handled by Radix Dialog onOpenChange. Skip when transcript owns j/k.
      if (isFocusInTranscript()) return;
      if (e.key === "j" && onNext) {
        e.preventDefault();
        onNext();
      }
      if (e.key === "k" && onPrev) {
        e.preventDefault();
        onPrev();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, onNext, onPrev]);

  const copyId = React.useCallback(() => {
    void navigator.clipboard.writeText(traceId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [traceId]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-[var(--bg-base)]/50 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
          data-testid="trace-viewer-backdrop"
        />
        <DialogPrimitive.Content
          data-testid="trace-viewer-modal"
          aria-modal="true"
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg outline-none",
            "inset-0 h-dvh max-h-dvh w-full rounded-none p-0",
            "sm:inset-2 sm:h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-1rem)] sm:rounded-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "duration-200",
            className,
          )}
          onOpenAutoFocus={(e) => {
            // Keep focus inside modal without stealing from first interactive child aggressively.
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus({ preventScroll: true });
          }}
        >
          <header
            className="flex shrink-0 items-center gap-space-3 border-b border-[var(--border-default)] bg-[var(--bg-primary)] px-space-4 py-space-3"
            data-testid="trace-viewer-chrome"
          >
            <div className="flex min-w-0 flex-1 items-center gap-space-2">
              {onPrev || onNext ? (
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={onPrev}
                    disabled={!onPrev}
                    aria-label="Previous trace"
                    className={cn(
                      "rounded p-space-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30",
                      FOCUS_RING_CLASS,
                    )}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={onNext}
                    disabled={!onNext}
                    aria-label="Next trace"
                    className={cn(
                      "rounded p-space-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30",
                      FOCUS_RING_CLASS,
                    )}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
              <TraceOutcomeBadge outcome={outcome ?? null} />
              <DialogPrimitive.Title className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]">
                {title ?? (
                  <span className="font-mono">{traceId.slice(0, 20)}…</span>
                )}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Fullscreen trace viewer for {traceId}
              </DialogPrimitive.Description>
              <div className="hidden min-w-0 items-center gap-1 sm:flex">
                <span className="truncate font-mono text-2xs text-[var(--text-muted)]">
                  {traceId}
                </span>
                <button
                  type="button"
                  onClick={copyId}
                  aria-label="Copy trace id"
                  data-testid="trace-viewer-copy-id"
                  className={cn(
                    "inline-flex min-h-8 min-w-8 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                    FOCUS_RING_CLASS,
                  )}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-[var(--terminal)]" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close trace viewer (Esc)"
              data-testid="trace-viewer-close"
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
                FOCUS_RING_CLASS,
              )}
            >
              <X className="h-3.5 w-3.5 sm:hidden" aria-hidden />
              <span className="hidden sm:inline">Close</span>
              <kbd
                className="hidden sm:inline-block rounded border border-[var(--border-subtle)] px-1 py-0.5 font-mono text-2xs text-[var(--text-muted)]"
                data-shortcut-chip="esc"
              >
                Esc
              </kbd>
            </button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
