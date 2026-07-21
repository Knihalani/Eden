"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: string;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked = false, onCheckedChange, label, className, disabled, id, ...props }, ref) => {
    return (
      <label
        className={cn(
          "inline-flex items-center gap-2 cursor-pointer select-none",
          disabled && "opacity-50 cursor-not-allowed",
          className,
        )}
      >
        <button
          ref={ref}
          type="button"
          role="switch"
          id={id}
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onCheckedChange?.(!checked)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors",
            "min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:h-6 sm:w-11",
            FOCUS_RING_CLASS,
            checked
              ? "bg-[var(--accent)] border-[var(--accent)]"
              : "bg-[var(--bg-tertiary)] border-[var(--border-default)]",
          )}
          {...props}
        >
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1/2 left-0.5 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-transform",
              checked && "translate-x-5",
            )}
          />
        </button>
        {label ? (
          <span className="text-sm text-[var(--text-primary)]">{label}</span>
        ) : null}
      </label>
    );
  },
);
Switch.displayName = "Switch";
