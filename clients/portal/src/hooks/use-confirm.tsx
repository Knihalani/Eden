"use client";

import { useCallback, useState, useRef } from "react";
import { Loader2 } from "lucide-react";
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

  const ConfirmDialog = state.open ? (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => close(false)}
    >
      <div
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-[var(--text)]">
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

// Silence unused-import warning when Loader2 isn't used directly.
void Loader2;
