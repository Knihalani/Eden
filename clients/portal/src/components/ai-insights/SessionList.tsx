"use client";

import { Loader2, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { cn } from "@/lib/utils";
import type { Session } from "./types";

export interface SessionListProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  onRetry: () => void;
  onClose: () => void;
}

export function SessionList({
  open,
  loading,
  error,
  sessions,
  activeSessionId,
  onSelect,
  onArchive,
  onRetry,
  onClose,
}: SessionListProps) {
  if (!open) return null;

  return (
    <div
      role="listbox"
      className="absolute left-0 top-full z-20 mt-space-1 max-h-56 w-64 overflow-y-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] py-space-1 shadow-lg"
    >
      {loading ? (
        <div className="flex items-center gap-space-1 px-space-3 py-space-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading…
        </div>
      ) : error ? (
        <div className="px-space-2 py-space-2">
          <ErrorState
            title="Could not load sessions"
            message={error}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            }
          />
        </div>
      ) : sessions.length === 0 ? (
        <div className="px-space-3 py-space-2 text-xs text-[var(--text-muted)]">
          No conversations yet
        </div>
      ) : (
        sessions.map((s) => (
          <div
            key={s.session_id}
            role="option"
            aria-selected={s.session_id === activeSessionId}
            className={cn(
              "flex w-full items-center gap-space-2 px-space-3 py-space-2 text-left text-xs",
              s.session_id === activeSessionId
                ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
              s.archived && "opacity-50",
            )}
          >
            <button
              type="button"
              onClick={() => {
                onSelect(s.session_id);
                onClose();
              }}
              className="min-w-0 flex-1 truncate text-left"
            >
              {s.title}
            </button>
            {!s.archived && (
              <button
                type="button"
                onClick={() => onArchive(s.session_id)}
                className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                aria-label="Archive"
              >
                <Archive className="h-3 w-3" />
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
