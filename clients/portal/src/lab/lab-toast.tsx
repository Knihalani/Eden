"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export type LabToast = {
  id: string;
  title: string;
  body?: string;
  href?: string;
  tone?: "default" | "ok" | "fail" | "accent";
};

type ToastContextValue = {
  toasts: LabToast[];
  pushToast: (toast: Omit<LabToast, "id">) => string;
  dismissToast: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function LabToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<LabToast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: Omit<LabToast, "id">) => {
      const id = `toast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev, { ...toast, id }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 8000);
      return id;
    },
    [],
  );

  const value = useMemo(
    () => ({ toasts, pushToast, dismissToast }),
    [toasts, pushToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg)] p-3.5 shadow-[0_8px_32px_rgba(0,0,0,0.45)]",
              toast.tone === "ok" &&
                "border-[var(--success)] bg-[var(--success-muted)]",
              toast.tone === "fail" &&
                "border-[var(--error)] bg-[var(--error-muted)]",
              toast.tone === "accent" && "border-[var(--accent)]",
            )}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "type-ui",
                    toast.tone === "ok" && "text-[var(--success)]",
                    toast.tone === "fail" && "text-[var(--error)]",
                    toast.tone !== "ok" &&
                      toast.tone !== "fail" &&
                      "text-[var(--text)]",
                  )}
                >
                  {toast.title}
                </p>
                {toast.body ? (
                  <p className="type-body mt-1">{toast.body}</p>
                ) : null}
                {toast.href ? (
                  <a
                    href={toast.href}
                    className="type-meta mt-2 inline-block text-[var(--accent)] underline-offset-2 hover:underline"
                    onClick={() => dismissToast(toast.id)}
                  >
                    Review
                  </a>
                ) : null}
              </div>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
                aria-label="Dismiss"
                onClick={() => dismissToast(toast.id)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useLabToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useLabToast must be used within LabToastProvider");
  return ctx;
}
