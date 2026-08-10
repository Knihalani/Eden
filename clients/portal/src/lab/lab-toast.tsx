"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, AlertCircle, Info, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type LabToast = {
  id: string;
  title: string;
  body?: string;
  href?: string;
  tone?: "default" | "ok" | "fail" | "accent";
};

/** Auto-dismiss lifetime — keep in sync with the CSS drain animation. */
export const TOAST_LIFETIME_MS = 8000;

const TONE_ICON = {
  default: Info,
  ok: CheckCircle2,
  fail: AlertCircle,
  accent: Sparkles,
} as const;

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
      }, TOAST_LIFETIME_MS);
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
        className="pointer-events-none fixed bottom-4 right-4 z-[120] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((toast) => {
          const tone = toast.tone ?? "default";
          const Icon = TONE_ICON[tone];
          return (
            <div
              key={toast.id}
              className={cn(
                "lab-toast pointer-events-auto relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg)] p-3.5 shadow-[0_8px_32px_rgba(0,0,0,0.45)]",
                tone === "ok" && "border-[var(--success)]",
                tone === "fail" && "border-[var(--error)]",
                tone === "accent" && "border-[var(--accent)]",
              )}
            >
              <div className="flex items-start gap-2.5">
                <Icon
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    tone === "ok" && "text-[var(--success)]",
                    tone === "fail" && "text-[var(--error)]",
                    tone === "accent" && "text-[var(--accent)]",
                    tone === "default" && "text-[var(--text-muted)]",
                  )}
                  strokeWidth={1.8}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "type-ui",
                      tone === "ok" && "text-[var(--success)]",
                      tone === "fail" && "text-[var(--error)]",
                      tone !== "ok" &&
                        tone !== "fail" &&
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
              {/* Auto-dismiss countdown. Drains over TOAST_LIFETIME_MS;
                  the animation matches the JS timeout above. */}
              <span
                className="lab-toast__progress"
                data-tone={tone}
                aria-hidden
              />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useLabToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useLabToast must be used within LabToastProvider");
  return ctx;
}

/**
 * Non-throwing toast accessor for components that render both inside and
 * outside ``LabToastProvider`` (e.g. dialogs mounted in tests or in pages
 * without the provider). Keeps hook calls unconditional — the dialogs must
 * never conditionally call ``useLabToast`` behind a try/catch, which would
 * break rules-of-hooks if the provider appeared or vanished between renders.
 */
export function useLabToastSafe(): { pushToast: ToastContextValue["pushToast"] | null } {
  const ctx = useContext(ToastContext);
  return { pushToast: ctx?.pushToast ?? null };
}
