"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isUsableObjectName, normalizeObjectName } from "@/lib/named-object";

/**
 * Name-first create dialog — required name, Cancel always (R022/R023/R024).
 */
export function NameCreateDialog({
  open,
  title,
  label = "Name",
  placeholder,
  confirmLabel = "Create",
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  label?: string;
  placeholder?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");

  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    setName("");
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(t);
      const el = triggerRef.current;
      if (el instanceof HTMLElement) el.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const usable = isUsableObjectName(name);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-[var(--scrim)] p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onCancel}
    >
      <form
        className="w-full max-w-sm overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)]"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!usable) return;
          onConfirm(normalizeObjectName(name));
        }}
      >
        <div className="space-y-3 px-5 py-4">
          <h2 id={titleId} className="type-ui text-[var(--text)]">
            {title}
          </h2>
          <label className="block space-y-1.5">
            <span className="type-label">{label}</span>
            <input
              ref={inputRef}
              className="ds-input w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={placeholder}
              aria-label={label}
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={!usable}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
