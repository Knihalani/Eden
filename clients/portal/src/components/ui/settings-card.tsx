"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SettingsCardProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}

export function SettingsCard({
  title,
  description,
  actions,
  className,
  contentClassName,
  children,
}: SettingsCardProps) {
  return (
    <div
      className={cn(
        "bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] p-6",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
          {description && (
            <p className="text-sm text-[var(--text-muted)] mt-1 leading-relaxed">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
      </div>
      <div className={cn(contentClassName)}>{children}</div>
    </div>
  );
}
