"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]",
          "placeholder:text-[var(--text-muted)]",
          FOCUS_RING_CLASS,
          "focus-visible:border-transparent",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "resize-y transition-colors duration-150",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
