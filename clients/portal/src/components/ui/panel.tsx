"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Panel — flat surface with no outer border. Use for grouping related
 * content that does not need a card affordance: list sections, data
 * wells, status blocks. Prefer Panel over Card when nesting or when
 * the page already has bordered tables — avoids border-stack chrome.
 *
 * Card = interactive / true container. Panel = grouping without a box.
 */
const panelVariants = cva(
  "rounded-xl overflow-hidden",
  {
    variants: {
      tone: {
        // Flat — no border, just a tonal lift over the page bg.
        flat: "bg-[var(--bg-secondary)]",
        // Inset — sunken look for read-only data wells.
        inset: "bg-[var(--bg-inset)] ring-1 ring-inset ring-[var(--border-subtle)]",
        // Subtle — the lightest lift, for grouping within a card.
        subtle: "bg-[var(--bg-primary)]/40",
        // Tint — accent-tinted for highlighted groupings.
        tint: "bg-[var(--accent-faint)]/40",
      },
      padding: {
        none: "",
        sm: "p-3",
        md: "p-4",
        lg: "p-5",
        xl: "p-6",
      },
    },
    defaultVariants: {
      tone: "flat",
      padding: "md",
    },
  }
);

export interface PanelProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof panelVariants> {}

const Panel = React.forwardRef<HTMLDivElement, PanelProps>(
  ({ className, tone, padding, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(panelVariants({ tone, padding }), className)}
      {...props}
    />
  )
);
Panel.displayName = "Panel";

export { Panel, panelVariants };
