"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  description?: string;
  exiting?: boolean;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, description?: string) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const addToast = useCallback(
    (type: ToastType, message: string, description?: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      setToasts((prev) => [...prev, { id, type, message, description }]);
      // Bump the auto-dismiss to 5s when a description is present —
      // a longer message takes longer to read.
      const dismissMs = description ? 5000 : 3000;
      setTimeout(() => removeToast(id), dismissMs);
    },
    [removeToast]
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return {
    success: (message: string, description?: string) =>
      context.addToast("success", message, description),
    error: (message: string, description?: string) =>
      context.addToast("error", message, description),
    info: (message: string, description?: string) =>
      context.addToast("info", message, description),
  };
}

function ToastContainer({
  toasts,
  removeToast,
}: {
  toasts: Toast[];
  removeToast: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-[calc(100vw-2rem)]">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}

const TOAST_STYLES: Record<
  ToastType,
  { bg: string; border: string; icon: typeof CheckCircle2; iconColor: string }
> = {
  success: {
    bg: "bg-[var(--terminal-faint)]",
    border: "border-[var(--terminal)]/30",
    icon: CheckCircle2,
    iconColor: "text-[var(--terminal)]",
  },
  error: {
    bg: "bg-[var(--error-dim)]",
    border: "border-[var(--error)]/30",
    icon: XCircle,
    iconColor: "text-[var(--error)]",
  },
  info: {
    bg: "bg-[var(--accent-faint)]",
    border: "border-[var(--accent)]/30",
    icon: Info,
    iconColor: "text-[var(--accent)]",
  },
};

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: () => void }) {
  const style = TOAST_STYLES[toast.type];
  const Icon = style.icon;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg",
        "min-w-[300px] max-w-[400px] pointer-events-auto",
        "bg-[var(--bg-primary)]",
        style.border,
        toast.exiting ? "toast-exit" : "toast-enter"
      )}
    >
      <Icon className={cn("w-5 h-5 flex-shrink-0", style.iconColor)} aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{toast.message}</p>
        {toast.description && (
          <p className="text-xs text-[var(--text-muted)] mt-0.5 leading-snug">
            {toast.description}
          </p>
        )}
      </div>
      <button
        onClick={onRemove}
        className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
        aria-label="Dismiss notification"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}