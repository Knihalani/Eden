"use client";

import { useState } from "react";
import { Bookmark, Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ViewsMenuTrigger } from "./QueryFilterBar";
import type { ViewState } from "./useSavedViews";
import type { SavedViewRecord } from "@/lib/api";

export interface ViewsMenuProps {
  views: Array<SavedViewRecord & { state: ViewState }>;
  activeViewId?: string;
  dirty?: boolean;
  onSelect: (viewId: string) => void;
  onSave: (name: string, isShared?: boolean) => Promise<void>;
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
  onDiscard,
  onDelete,
  className,
}: ViewsMenuProps) {
  const [open, setOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);

  const personal = views.filter((v) => !v.is_shared);
  const shared = views.filter((v) => v.is_shared);

  const handleSave = async () => {
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

  return (
    <div className={cn("relative", className)}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ViewsMenuTrigger dirty={dirty} />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-64 rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg p-2 text-sm">
          <button
            type="button"
            className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] flex items-center gap-2"
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
              <p className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
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
              <p className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
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
            <div className="flex gap-1">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Save as…"
                className="flex-1 px-2 py-1 text-xs rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]"
              />
              <button
                type="button"
                disabled={saving || !saveName.trim()}
                onClick={() => void handleSave()}
                className="px-2 py-1 text-xs rounded bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-50"
              >
                Save
              </button>
            </div>
            {dirty && (
              <button
                type="button"
                onClick={() => {
                  onDiscard();
                  setOpen(false);
                }}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Discard changes
              </button>
            )}
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
        className="flex-1 text-left px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] flex items-center gap-2 min-w-0"
        onClick={onSelect}
      >
        <Bookmark className={cn("w-3.5 h-3.5 shrink-0", active ? "text-[var(--accent)]" : "text-[var(--text-muted)]")} />
        <span className="truncate">{view.name}</span>
      </button>
      {onDelete && (
        <button
          type="button"
          aria-label={`Delete ${view.name}`}
          className="p-1 opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--error)]"
          onClick={() => void onDelete(view.id)}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
