"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

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
   * Mobile / mid viewport: drawer overlay.
   * Laminar breakpoints (§B.4): ≥1280 (xl) split; 768–1279 drawer; &lt;768 full drawer.
   * List stays mounted in the parent ResourcePageShell / CoreResourcePage table slot.
   */
  mobileDrawer?: boolean;
}

/**
 * Master–detail panel chrome (UX-P0-07).
 * Traces: drive `open` from canonical query key `traceId` (aliases `trace_id` /
 * `trace` via useResourceUrlState); Close must clear that param so the list
 * remains mounted in ResourcePageShell without a route change.
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
  widthClassName = "xl:w-[min(720px,45vw)]",
  onPrev,
  onNext,
  mobileDrawer = true,
}: DetailPanelShellProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    // Defer so drawer paint completes before focus move.
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
        aria-modal={mobileDrawer ? "true" : undefined}
        tabIndex={-1}
        data-testid="detail-panel-shell"
        className={cn(
          "panel-enter flex flex-col shrink-0 border-[var(--border-default)] bg-[var(--bg-primary)] outline-none",
          mobileDrawer &&
            "fixed inset-y-0 right-0 z-50 w-full max-w-lg border-l shadow-xl xl:shadow-none xl:static xl:z-auto xl:max-w-none",
          !mobileDrawer && "border-l xl:sticky xl:top-20",
          "w-full",
          widthClassName,
          "max-h-[calc(100dvh-4rem)] xl:max-h-[calc(100vh-8rem)]",
        )}
        aria-label="Detail panel"
      >
        <header className="flex items-center justify-between gap-space-2 px-space-4 py-space-3 border-b border-[var(--border-default)] shrink-0">
          <div className="flex items-center gap-space-1 min-w-0">
            {onPrev ? (
              <button
                type="button"
                onClick={onPrev}
                className="p-space-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                aria-label="Previous item"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            ) : null}
            <div className="min-w-0 font-medium text-sm text-[var(--text-primary)] truncate">
              {title}
            </div>
            {onNext ? (
              <button
                type="button"
                onClick={onNext}
                className="p-space-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                aria-label="Next item"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-space-2 shrink-0">
            {headerActions}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close detail panel"
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-2 py-1 rounded hover:bg-[var(--bg-tertiary)]"
            >
              Close
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
        <div className="flex-1 overflow-y-auto min-h-0 overscroll-contain">{children}</div>
      </aside>
    </>
  );
}
