"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Form field — secondary fill so inputs ≠ cards; height 28–32px (`h-8`).
 * Touch: `max-md:min-h-11` without growing desktop chrome.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-8 min-h-8 max-md:min-h-11 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-primary)]",
          "placeholder:text-[var(--text-muted)]",
          FOCUS_RING_CLASS,
          "focus-visible:border-transparent",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "transition-colors duration-150",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
