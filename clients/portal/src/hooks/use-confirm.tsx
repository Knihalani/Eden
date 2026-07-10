"use client";

import { useCallback, useState, useRef, useEffect, useId } from "react";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
}

interface DialogState extends ConfirmOptions {
  open: boolean;
  resolve: ((value: boolean) => void) | null;
}

const initialState: DialogState = {
  open: false,
  title: "",
  resolve: null,
};

/**
 * Promise-based confirm dialog hook.
 *
 * Usage:
 *   const { confirm, ConfirmDialog } = useConfirm();
 *   if (await confirm({ title: "...", variant: "destructive" })) {
 *     // user clicked Confirm
 *   }
 *   return <div>{ConfirmDialog}</div>;
 */
export function useConfirm() {
  const [state, setState] = useState<DialogState>(initialState);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  const titleId = useId();

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setState({ ...opts, open: true, resolve });
    });
  }, []);

  const close = (value: boolean) => {
    if (resolveRef.current) {
      resolveRef.current(value);
      resolveRef.current = null;
    }
    setState((s) => ({ ...s, open: false, resolve: null }));
  };

  // Escape closes the dialog (same as Cancel). Without this the
  // backdrop click is the only way to dismiss the modal with the
  // keyboard, which fails WCAG 2.1.1 (keyboard accessibility).
  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // close is stable (no deps change), so this effect is gated
    // purely on open.
  }, [state.open]);

  const ConfirmDialog = state.open ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] backdrop-blur-sm"
      onClick={() => close(false)}
    >
      <div
        className="w-full max-w-md rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="text-lg font-semibold text-[var(--text-primary)]">
          {state.title}
        </h2>
        {state.description && (
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            {state.description}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => close(false)}
          >
            {state.cancelLabel || "Cancel"}
          </Button>
          <Button
            type="button"
            variant={state.variant === "destructive" ? "destructive" : "default"}
            onClick={() => close(true)}
          >
            {state.confirmLabel || "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, ConfirmDialog };
}
