"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bookmark, Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { ViewsMenuTrigger } from "./QueryFilterBar";
import type { ViewState } from "./useSavedViews";
import type { SavedViewRecord } from "@/lib/api";

export interface ViewsMenuProps {
  views: Array<SavedViewRecord & { state: ViewState }>;
  activeViewId?: string;
  /** Amber when filters|sort|columns diverge from active saved view / Default. */
  dirty?: boolean;
  onSelect: (viewId: string) => void;
  /** Save as new view (always available). */
  onSave: (name: string, isShared?: boolean) => Promise<void>;
  /** Write current state back to the active saved view (Laminar "Save changes"). */
  onSaveChanges?: () => Promise<void>;
  onDiscard: () => void;
  onDelete?: (viewId: string) => Promise<void>;
  className?: string;
}

export function ViewsMenu({
  views,
  activeViewId,
  dirty,
  onSelect,
  onSave,
  onSaveChanges,
  onDiscard,
  onDelete,
  className,
}: ViewsMenuProps) {
  const [open, setOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const personal = views.filter((v) => !v.is_shared);
  const shared = views.filter((v) => v.is_shared);
  const canSaveChanges = Boolean(dirty && activeViewId && onSaveChanges);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const handleSaveAs = async () => {
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      await onSave(saveName.trim());
      setSaveName("");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveChanges = async () => {
    if (!onSaveChanges) return;
    setSaving(true);
    try {
      await onSaveChanges();
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("relative", className)} ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        className={cn("rounded-lg min-h-11", FOCUS_RING_CLASS)}
        data-dirty={dirty ? "true" : undefined}
      >
        <ViewsMenuTrigger dirty={dirty} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Saved views"
          className="absolute z-30 mt-1 w-64 rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg p-2 text-sm"
        >
          <button
            type="button"
            role="menuitem"
            className={cn(
              "w-full text-left px-2 min-h-11 rounded-lg hover:bg-[var(--bg-tertiary)] flex items-center gap-2",
              FOCUS_RING_CLASS,
            )}
            onClick={() => {
              onSelect("");
              setOpen(false);
            }}
          >
            <Check className={cn("w-3.5 h-3.5", !activeViewId ? "opacity-100" : "opacity-0")} />
            Default
          </button>

          {personal.length > 0 && (
            <>
              <p className="px-2 pt-2 pb-1 text-2xs uppercase tracking-wide text-[var(--text-muted)]">
                Personal
              </p>
              {personal.map((v) => (
                <ViewRow
                  key={v.id}
                  view={v}
                  active={activeViewId === v.id}
                  onSelect={() => {
                    onSelect(v.id);
                    setOpen(false);
                  }}
                  onDelete={onDelete}
                />
              ))}
            </>
          )}

          {shared.length > 0 && (
            <>
              <p className="px-2 pt-2 pb-1 text-2xs uppercase tracking-wide text-[var(--text-muted)]">
                Project
              </p>
              {shared.map((v) => (
                <ViewRow
                  key={v.id}
                  view={v}
                  active={activeViewId === v.id}
                  onSelect={() => {
                    onSelect(v.id);
                    setOpen(false);
                  }}
                  onDelete={onDelete}
                />
              ))}
            </>
          )}

          <div className="border-t border-[var(--border-default)] mt-2 pt-2 space-y-2 px-1">
            {canSaveChanges ? (
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => void handleSaveChanges()}
                className="w-full min-h-11 bg-[var(--warning)] text-[var(--bg-primary)] hover:bg-[var(--warning)]/90"
                data-testid="views-save-changes"
              >
                Save changes
              </Button>
            ) : null}
            <div className="flex gap-1">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveAs();
                  }
                }}
                placeholder="Save as…"
                aria-label="Save as new view name"
                className={cn(
                  "flex-1 min-h-11 px-2 text-xs rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]",
                  FOCUS_RING_CLASS,
                )}
              />
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={saving || !saveName.trim()}
                onClick={() => void handleSaveAs()}
                className="min-h-11"
                data-testid="views-save-as"
              >
                Save as
              </Button>
            </div>
            {dirty ? (
              <button
                type="button"
                onClick={() => {
                  onDiscard();
                  setOpen(false);
                }}
                className={cn(
                  "min-h-11 px-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg",
                  FOCUS_RING_CLASS,
                )}
                data-testid="views-discard"
              >
                Discard changes
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function ViewRow({
  view,
  active,
  onSelect,
  onDelete,
}: {
  view: SavedViewRecord;
  active: boolean;
  onSelect: () => void;
  onDelete?: (id: string) => Promise<void>;
}) {
  return (
    <div className="flex items-center gap-1 group">
      <button
        type="button"
        role="menuitem"
        className={cn(
          "flex-1 text-left px-2 min-h-11 rounded-lg hover:bg-[var(--bg-tertiary)] flex items-center gap-2 min-w-0",
          FOCUS_RING_CLASS,
        )}
        onClick={onSelect}
      >
        <Bookmark
          className={cn(
            "w-3.5 h-3.5 shrink-0",
            active ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
          )}
        />
        <span className="truncate">{view.name}</span>
      </button>
      {onDelete ? (
        <button
          type="button"
          aria-label={`Delete ${view.name}`}
          className={cn(
            "inline-flex items-center justify-center min-h-11 min-w-11 rounded-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--text-muted)] hover:text-[var(--error)]",
            FOCUS_RING_CLASS,
          )}
          onClick={() => void onDelete(view.id)}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      ) : null}
    </div>
  );
}
