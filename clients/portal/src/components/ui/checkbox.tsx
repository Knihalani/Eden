"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";

export interface CheckboxProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: string;
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
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
          role="checkbox"
          id={id}
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onCheckedChange?.(!checked)}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
            "min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:h-5 sm:w-5",
            FOCUS_RING_CLASS,
            checked
              ? "bg-[var(--accent)] border-[var(--accent)] text-[var(--bg-primary)]"
              : "border-[var(--border-default)] bg-[var(--bg-primary)] hover:border-[var(--border-strong)]",
          )}
          {...props}
        >
          {checked ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
        </button>
        {label ? (
          <span className="text-sm text-[var(--text-primary)]">{label}</span>
        ) : null}
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";
