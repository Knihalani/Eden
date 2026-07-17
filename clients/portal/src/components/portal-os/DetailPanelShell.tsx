"use client";

import { useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
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
  /** Mobile: render as full-screen drawer overlay */
  mobileDrawer?: boolean;
}

export function DetailPanelShell({
  open,
  onClose,
  title,
  tabs,
  activeTab,
  onTabChange,
  headerActions,
  children,
  widthClassName = "lg:w-[min(720px,45vw)]",
  onPrev,
  onNext,
  mobileDrawer = true,
}: DetailPanelShellProps) {
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

  return (
    <>
      {mobileDrawer && (
        <div
          role="presentation"
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-[var(--bg-base)]/40 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        role="dialog"
        aria-modal={mobileDrawer ? "true" : undefined}
        className={cn(
          "panel-enter flex flex-col shrink-0 border-[var(--border-default)] bg-[var(--bg-primary)]",
          mobileDrawer &&
            "fixed inset-y-0 right-0 z-50 w-full max-w-lg border-l shadow-xl lg:shadow-none lg:static lg:z-auto",
          !mobileDrawer && "border-l",
          "w-full",
          widthClassName,
          "max-h-[calc(100dvh-4rem)] lg:max-h-[calc(100vh-8rem)] lg:sticky lg:top-20",
        )}
        aria-label="Detail panel"
      >
        <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border-default)] shrink-0">
          <div className="flex items-center gap-1 min-w-0">
            {onPrev ? (
              <button
                type="button"
                onClick={onPrev}
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
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
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                aria-label="Next item"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
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
        {tabs && tabs.length > 0 ? (
          <div
            role="tablist"
            aria-label="Detail panel sections"
            className="flex gap-1 px-4 py-2 border-b border-[var(--border-default)] shrink-0 overflow-x-auto"
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={activeTab === t.id}
                onClick={() => onTabChange?.(t.id)}
                className={cn(
                  "px-3 py-1.5 text-xs rounded-md whitespace-nowrap",
                  activeTab === t.id
                    ? "bg-[var(--accent-light)] text-[var(--accent)] font-medium"
                    : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto min-h-0 overscroll-contain">{children}</div>
      </aside>
    </>
  );
}
