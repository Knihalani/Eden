"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";

/**
 * Button grammar (Wave 2 freeze):
 * - `default` — sole solid accent CTA (one per screen)
 * - `secondary` — quiet / outline (aliases the old competing solid secondary)
 * - `destructive` / `danger` — one error delete style (aliases)
 * - `outline` / `ghost` / `link` — quiet utilities
 * - `emerald` — deprecated alias of `default` (do not use for new CTAs)
 *
 * Visual height 28–32px (`h-8`); `max-md:min-h-11` keeps touch targets on mobile.
 */
const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    FOCUS_RING_CLASS,
  ),
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]",
        /** Quiet secondary — same grammar as outline (collapsed solid secondary). */
        secondary:
          "border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]",
        destructive:
          "bg-[var(--error)] text-[var(--bg-primary)] hover:bg-[var(--error)]/90",
        /** Alias of destructive — one error delete style. */
        danger:
          "bg-[var(--error)] text-[var(--bg-primary)] hover:bg-[var(--error)]/90",
        outline:
          "border border-[var(--border-default)] bg-transparent hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]",
        ghost: "hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]",
        /** @deprecated Use `default`. Kept as alias for call-site safety. */
        emerald:
          "bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]",
        link: "text-[var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 min-h-8 max-md:min-h-11 px-3 py-1.5",
        sm: "h-7 min-h-7 max-md:min-h-11 px-2.5 text-xs",
        lg: "h-9 min-h-9 max-md:min-h-11 px-5 text-sm",
        icon: "h-8 w-8 min-h-8 min-w-8 max-md:min-h-11 max-md:min-w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows a spinner + disables the button while true. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="animate-spin" />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
