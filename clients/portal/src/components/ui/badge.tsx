"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2",
  {
    variants: {
      variant: {
        // Status variants
        default: "border-transparent bg-[var(--accent)] text-[var(--bg-primary)]",
        secondary: "border-transparent bg-[var(--accent-bg)] text-[var(--accent)]",
        destructive: "border-transparent bg-[var(--error)] text-[var(--bg-primary)]",

        // Status colors
        success: "border-transparent bg-[var(--success-bg)] text-[var(--success)]",
        warning: "border-transparent bg-[var(--warning-bg)] text-[var(--warning)]",
        error: "border-transparent bg-[var(--error-bg)] text-[var(--error)]",

        // Outcome tier variants
        gold: "border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)]",
        silver: "border-[var(--text-muted)]/30 bg-[var(--text-muted)]/10 text-[var(--text-secondary)]",
        bronze: "border-[var(--warning)]/30 bg-[var(--warning-bg)] text-[var(--warning)]",
        failed: "border-[var(--error)]/30 bg-[var(--error)]/10 text-[var(--error)]",

        // Pipeline stage variants
        planning: "border-[var(--stage-planning)]/30 bg-[var(--stage-planning)]/10 text-[var(--stage-planning)]",
        criticizing: "border-[var(--stage-criticizing)]/30 bg-[var(--stage-criticizing)]/10 text-[var(--stage-criticizing)]",
        refining: "border-[var(--stage-refining)]/30 bg-[var(--stage-refining)]/10 text-[var(--stage-refining)]",
        fact_checking: "border-[var(--stage-fact-checking)]/30 bg-[var(--stage-fact-checking)]/10 text-[var(--stage-fact-checking)]",
        executing: "border-[var(--stage-executing)]/30 bg-[var(--stage-executing)]/10 text-[var(--stage-executing)]",
        code_quality: "border-[var(--stage-code-quality)]/30 bg-[var(--stage-code-quality)]/10 text-[var(--stage-code-quality)]",
        verifying: "border-[var(--stage-verifying)]/30 bg-[var(--stage-verifying)]/10 text-[var(--stage-verifying)]",
        testing: "border-[var(--stage-testing)]/30 bg-[var(--stage-testing)]/10 text-[var(--stage-testing)]",
        archiving: "border-[var(--stage-archiving)]/30 bg-[var(--stage-archiving)]/10 text-[var(--stage-archiving)]",

        // Generic outline
        outline: "border-[var(--border)] text-[var(--text-primary)]",

        // Color variants
        cyan: "border-[var(--accent)]/30 bg-[var(--accent-faint)] text-[var(--accent)]",
        purple: "border-transparent bg-[var(--accent-purple-bg)] text-[var(--accent-purple)]",
        emerald: "border-transparent bg-[var(--success-dim)] text-[var(--success)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
Badge.displayName = "Badge";

export { Badge, badgeVariants };