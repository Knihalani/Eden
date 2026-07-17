"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from "lucide-react";

type ToastType = "success" | "error" | "info" | "warning";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  description?: string;
  action?: ToastAction;
  exiting?: boolean;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (
    type: ToastType,
    message: string,
    description?: string,
    action?: ToastAction,
  ) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);
const MAX_QUEUE = 5;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pausedRef = useRef<Set<string>>(new Set());
  const remainingRef = useRef<Map<string, number>>(new Map());
  const startedRef = useRef<Map<string, number>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t) clearTimeout(t);
    timersRef.current.delete(id);
  }, []);

  const removeToast = useCallback(
    (id: string) => {
      clearTimer(id);
      pausedRef.current.delete(id);
      remainingRef.current.delete(id);
      startedRef.current.delete(id);
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
      );
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 200);
    },
    [clearTimer],
  );

  const scheduleDismiss = useCallback(
    (id: string, ms: number) => {
      clearTimer(id);
      startedRef.current.set(id, Date.now());
      remainingRef.current.set(id, ms);
      timersRef.current.set(
        id,
        setTimeout(() => {
          if (!pausedRef.current.has(id)) removeToast(id);
        }, ms),
      );
    },
    [clearTimer, removeToast],
  );

  const pauseToast = useCallback(
    (id: string) => {
      if (pausedRef.current.has(id)) return;
      pausedRef.current.add(id);
      const started = startedRef.current.get(id) ?? Date.now();
      const remaining = remainingRef.current.get(id) ?? 3000;
      const elapsed = Date.now() - started;
      remainingRef.current.set(id, Math.max(500, remaining - elapsed));
      clearTimer(id);
    },
    [clearTimer],
  );

  const resumeToast = useCallback(
    (id: string) => {
      if (!pausedRef.current.has(id)) return;
      pausedRef.current.delete(id);
      const left = remainingRef.current.get(id) ?? 3000;
      scheduleDismiss(id, left);
    },
    [scheduleDismiss],
  );

  const addToast = useCallback(
    (
      type: ToastType,
      message: string,
      description?: string,
      action?: ToastAction,
    ) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      setToasts((prev) => {
        const next = [...prev, { id, type, message, description, action }];
        return next.length > MAX_QUEUE ? next.slice(next.length - MAX_QUEUE) : next;
      });
      const dismissMs = action ? 6000 : description ? 5000 : type === "warning" ? 5000 : 3000;
      scheduleDismiss(id, dismissMs);
    },
    [scheduleDismiss],
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer
        toasts={toasts}
        removeToast={removeToast}
        onPause={pauseToast}
        onResume={resumeToast}
      />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return {
    success: (message: string, description?: string, action?: ToastAction) =>
      context.addToast("success", message, description, action),
    error: (message: string, description?: string, action?: ToastAction) =>
      context.addToast("error", message, description, action),
    info: (message: string, description?: string, action?: ToastAction) =>
      context.addToast("info", message, description, action),
    warning: (message: string, description?: string, action?: ToastAction) =>
      context.addToast("warning", message, description, action),
  };
}

function ToastContainer({
  toasts,
  removeToast,
  onPause,
  onResume,
}: {
  toasts: Toast[];
  removeToast: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-20 right-4 flex flex-col gap-2 pointer-events-none max-w-[calc(100vw-2rem)]"
      style={{ zIndex: "var(--z-toast)" }}
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onRemove={() => removeToast(toast.id)}
          onPause={() => onPause(toast.id)}
          onResume={() => onResume(toast.id)}
        />
      ))}
    </div>
  );
}

const TOAST_STYLES: Record<
  ToastType,
  { border: string; icon: typeof CheckCircle2; iconColor: string }
> = {
  success: {
    border: "border-[var(--terminal)]/30",
    icon: CheckCircle2,
    iconColor: "text-[var(--terminal)]",
  },
  error: {
    border: "border-[var(--error)]/30",
    icon: XCircle,
    iconColor: "text-[var(--error)]",
  },
  info: {
    border: "border-[var(--accent)]/30",
    icon: Info,
    iconColor: "text-[var(--accent)]",
  },
  warning: {
    border: "border-[var(--warning)]/40",
    icon: AlertTriangle,
    iconColor: "text-[var(--warning)]",
  },
};

function ToastItem({
  toast,
  onRemove,
  onPause,
  onResume,
}: {
  toast: Toast;
  onRemove: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const style = TOAST_STYLES[toast.type];
  const Icon = style.icon;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg",
        "min-w-[300px] max-w-[400px] pointer-events-auto",
        "bg-[var(--bg-primary)]",
        style.border,
        toast.exiting ? "toast-exit" : "toast-enter",
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
      {toast.action && (
        <button
          onClick={() => {
            toast.action!.onClick();
            onRemove();
          }}
          className="text-xs font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)] px-2 py-1 rounded transition-colors flex-shrink-0"
        >
          {toast.action.label}
        </button>
      )}
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
