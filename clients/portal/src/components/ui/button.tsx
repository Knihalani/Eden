"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent)] text-[var(--bg-primary)] hover:bg-[var(--accent-hover)] focus:ring-[var(--accent)]",
        destructive:
          "bg-[var(--error)] text-[var(--bg-primary)] hover:bg-[var(--error)]/90 focus:ring-[var(--error)]",
        outline:
          "border border-[var(--border)] bg-transparent hover:bg-[var(--accent-bg)] hover:text-[var(--accent)]",
        ghost: "hover:bg-[var(--accent-bg)] hover:text-[var(--accent)]",
        secondary:
          "bg-[var(--primary)] text-[var(--bg-primary)] hover:bg-[var(--primary-hover)] focus:ring-[var(--primary)]",
        emerald:
          "bg-[var(--accent-2)] text-[var(--bg-base)] hover:bg-[var(--accent-2)]/90 focus:ring-[var(--accent-2)]",
        danger:
          "bg-[var(--error-dim)] text-[var(--error)] border border-[var(--error)]/30 hover:bg-[var(--error)]/20 focus:ring-[var(--error)]",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
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
  isLoading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, isLoading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading ? (
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