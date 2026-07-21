"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { FOCUS_RING_CLASS } from "./focus-ring";

export interface TagProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Show a small ✕ button and call this when clicked. */
  onRemove?: () => void;
  /** Accessible label for the remove button. */
  removeLabel?: string;
}

/**
 * Dismissible chip — wraps Badge for shared pill grammar.
 * Prefer Badge for static labels; Tag only when the chip is removable.
 */
function Tag({ className, onRemove, removeLabel = "Remove", children, ...props }: TagProps) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1 rounded-full pl-2.5 pr-1 py-0.5 font-medium",
        "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-transparent",
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
            FOCUS_RING_CLASS,
            "transition-colors"
          )}
        >
          <X className="w-3 h-3" aria-hidden />
        </button>
      )}
    </Badge>
  );
}
Tag.displayName = "Tag";

export { Tag };
