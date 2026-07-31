"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ConfirmRequest = {
  message: string;
  resolve: (ok: boolean) => void;
};

type ConfirmFn = (message: string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Confirm dialog for irreversible archive/delete. Replaces ``window.confirm``.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => {
      setRequest({ message, resolve });
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    setRequest((current) => {
      current?.resolve(ok);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!request) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request ? (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-[var(--scrim)] p-3 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={() => close(false)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-3 px-5 py-4">
              <h2 id={titleId} className="type-ui text-[var(--text)]">
                Confirm
              </h2>
              <p className="type-body text-[var(--text-secondary)]">
                {request.message}
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
              <button
                ref={cancelRef}
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={() => close(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                onClick={() => close(true)}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return useCallback(
    async (message: string) => {
      if (ctx) return ctx(message);
      if (typeof window === "undefined") return false;
      return window.confirm(message);
    },
    [ctx],
  );
}
