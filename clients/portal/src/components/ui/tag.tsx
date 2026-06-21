"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TagProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Show a small ✕ button and call this when clicked. */
  onRemove?: () => void;
  /** Accessible label for the remove button. */
  removeLabel?: string;
}

function Tag({ className, onRemove, removeLabel = "Remove", children, ...props }: TagProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-full pl-2.5 pr-1 py-0.5 text-xs font-medium",
        "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
        className
      )}
      {...props}
    >
      <span>{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className={cn(
            "inline-flex items-center justify-center w-4 h-4 rounded-full",
            "hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]",
            "focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-1 focus:ring-offset-[var(--bg-tertiary)]",
            "transition-colors"
          )}
        >
          <X className="w-3 h-3" aria-hidden />
        </button>
      )}
    </div>
  );
}
Tag.displayName = "Tag";

export { Tag };
