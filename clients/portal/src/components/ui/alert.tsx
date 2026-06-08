"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

export type AlertVariant = "error" | "warning" | "info" | "success";

const VARIANT_STYLES: Record<AlertVariant, {
  wrap: string;
  icon: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = {
  error: {
    wrap: "border-[var(--error)]/20 bg-[var(--error-bg)] text-[var(--error)]",
    icon: "text-[var(--error)]",
    Icon: AlertCircle,
  },
  warning: {
    wrap: "border-[var(--warning)]/20 bg-[var(--warning-bg)] text-[var(--warning)]",
    icon: "text-[var(--warning)]",
    Icon: AlertTriangle,
  },
  info: {
    wrap: "border-[var(--accent)]/20 bg-[var(--accent-faint)] text-[var(--accent)]",
    icon: "text-[var(--accent)]",
    Icon: Info,
  },
  success: {
    wrap: "border-[var(--terminal)]/20 bg-[var(--terminal-faint)] text-[var(--terminal)]",
    icon: "text-[var(--terminal)]",
    Icon: CheckCircle2,
  },
};

export interface AlertProps {
  variant?: AlertVariant;
  title: string;
  description?: string;
  action?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}

export function Alert({
  variant = "info",
  title,
  description,
  action,
  onDismiss,
  className,
}: AlertProps) {
  const styles = VARIANT_STYLES[variant];
  const Icon = styles.Icon;
  return (
    <div
      role={variant === "error" || variant === "warning" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 p-4 rounded-lg border text-sm",
        styles.wrap,
        className,
      )}
    >
      <Icon className={cn("w-4 h-4 mt-0.5 shrink-0", styles.icon)} />
      <div className="flex-1 min-w-0">
        <p className="font-medium">{title}</p>
        {description && (
          <p className="mt-0.5 opacity-80 leading-relaxed">{description}</p>
        )}
        {action && <div className="mt-2">{action}</div>}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}
