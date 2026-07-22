"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

export interface DetailPanelTab {
  id: string;
  label: string;
}

export interface DetailPanelShellProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  tabs?: DetailPanelTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  headerActions?: ReactNode;
  children: ReactNode;
  widthClassName?: string;
  onPrev?: () => void;
  onNext?: () => void;
  /**
   * Below xl (≥1280): fixed drawer overlay. List stays mounted in
   * ResourcePageShell master slot.
   */
  mobileDrawer?: boolean;
  className?: string;
}

/**
 * Master–detail panel chrome. Esc / Close clear selection via `onClose`.
 */
export function DetailPanelShell({
  open,
  onClose,
  title,
  tabs,
  activeTab,
  onTabChange,
  headerActions,
  children,
  widthClassName = "xl:min-w-[400px] xl:w-full",
  onPrev,
  onNext,
  mobileDrawer = true,
  className,
}: DetailPanelShellProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const id = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(id);
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (prev && typeof prev.focus === "function" && document.contains(prev)) {
        prev.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isFormField) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
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

  if (!open) return null;

  const tabValue = activeTab ?? tabs?.[0]?.id;

  return (
    <>
      {mobileDrawer ? (
        <div
          role="presentation"
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-[var(--bg-base)]/40 xl:hidden"
          onClick={onClose}
          data-testid="detail-panel-backdrop"
        />
      ) : null}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal={mobileDrawer ? true : undefined}
        tabIndex={-1}
        data-testid="detail-panel-shell"
        className={cn(
          "panel-enter flex shrink-0 flex-col border-[var(--border-default)] bg-[var(--bg-primary)] outline-none",
          mobileDrawer &&
            "fixed inset-y-0 right-0 z-50 w-full max-w-lg border-l shadow-xl xl:static xl:z-auto xl:max-w-none xl:shadow-none",
          !mobileDrawer && "border-l xl:sticky xl:top-20",
          "w-full",
          widthClassName,
          "max-h-[calc(100dvh-4rem)] xl:max-h-[calc(100vh-8rem)]",
          className,
        )}
        aria-label="Detail panel"
      >
        <header className="flex shrink-0 items-center justify-between gap-space-2 border-b border-[var(--border-default)] px-space-4 py-space-3">
          <div className="flex min-w-0 items-center gap-space-1">
            {onPrev ? (
              <button
                type="button"
                onClick={onPrev}
                className={cn(
                  "rounded p-space-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]",
                  FOCUS_RING_CLASS,
                )}
                aria-label="Previous item"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : null}
            <div className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]">
              {title}
            </div>
            {onNext ? (
              <button
                type="button"
                onClick={onNext}
                className={cn(
                  "rounded p-space-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]",
                  FOCUS_RING_CLASS,
                )}
                aria-label="Next item"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-space-2">
            {headerActions}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close detail panel (Esc)"
              className={cn(
                "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
                FOCUS_RING_CLASS,
              )}
            >
              <X className="h-3.5 w-3.5 sm:hidden" aria-hidden />
              <span className="hidden sm:inline">Close</span>
              <kbd
                className="hidden rounded border border-[var(--border-subtle)] px-1 py-0.5 font-mono text-xs text-[var(--text-muted)] sm:inline-block"
                data-shortcut-chip="esc"
              >
                Esc
              </kbd>
            </button>
          </div>
        </header>
        {tabs && tabs.length > 0 && tabValue ? (
          <Tabs
            value={tabValue}
            onValueChange={(id) => onTabChange?.(id)}
            className="shrink-0 border-b border-[var(--border-default)]"
          >
            <TabsList
              variant="underline"
              aria-label="Detail panel sections"
              className="h-auto w-full justify-start gap-space-2 overflow-x-auto rounded-none bg-transparent px-space-4 pt-space-2"
            >
              {tabs.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  variant="underline"
                  className="min-h-11 whitespace-nowrap px-space-3 text-xs"
                >
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </aside>
    </>
  );
}
