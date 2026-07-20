"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";

const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    FOCUS_RING_CLASS,
  ),
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent)] text-[var(--bg-primary)] hover:bg-[var(--accent-hover)]",
        destructive:
          "bg-[var(--error)] text-[var(--bg-primary)] hover:bg-[var(--error)]/90",
        outline:
          "border border-[var(--border)] bg-transparent hover:bg-[var(--accent-bg)] hover:text-[var(--accent)]",
        ghost: "hover:bg-[var(--accent-bg)] hover:text-[var(--accent)]",
        secondary:
          "bg-[var(--primary)] text-[var(--bg-primary)] hover:bg-[var(--primary-hover)]",
        emerald:
          "bg-[var(--accent-2)] text-[var(--bg-base)] hover:bg-[var(--accent-2)]/90",
        danger:
          "bg-[var(--error-dim)] text-[var(--error)] border border-[var(--error)]/30 hover:bg-[var(--error)]/20",
        link: "text-[var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-11 h-11 px-4 py-2",
        // Dense secondary: compact type/padding, still ≥44px touch (W15).
        sm: "min-h-11 h-11 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        icon: "min-h-11 min-w-11 h-11 w-11",
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
  /** ponytail: aligned with StatCard's `loading` prop. Shows a
   *  spinner + disables the button while true. */
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
