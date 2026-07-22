"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";

const Tabs = TabsPrimitive.Root;

/** Hub default is underline; `default` (boxed) and `pills` remain for Settings/embedded. */
const tabsListVariants = cva("inline-flex max-w-full items-center justify-center", {
  variants: {
    variant: {
      default: "gap-2 p-1 bg-[var(--accent-bg)] rounded-lg",
      underline: "gap-8 border-b border-[var(--border)] overflow-x-auto",
      pills: "gap-1 p-1",
    },
  },
  defaultVariants: {
    variant: "underline",
  },
});

const tabsTriggerVariants = cva(
  cn(
    "inline-flex max-w-[12rem] shrink-0 items-center justify-center truncate whitespace-nowrap text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50",
    FOCUS_RING_CLASS,
  ),
  {
    variants: {
      variant: {
        default: "rounded-md px-3 py-1.5 data-[state=active]:bg-[var(--bg-primary)] data-[state=active]:text-[var(--accent)] text-[var(--text-secondary)]",
        underline:
          "h-8 max-md:min-h-11 border-b-2 border-transparent -mb-px pb-3 max-md:pb-3 data-[state=active]:border-[var(--accent)] data-[state=active]:text-[var(--accent)] text-[var(--text-muted)]",
        pills: "rounded-full px-3 py-1.5 data-[state=active]:bg-[var(--accent)] data-[state=active]:text-[var(--bg-base)] text-[var(--text-secondary)]",
      },
    },
    defaultVariants: {
      variant: "underline",
    },
  }
);

interface TabsListProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

const TabsList = React.forwardRef<React.ElementRef<typeof TabsPrimitive.List>, TabsListProps>(
  ({ className, variant, ...props }, ref) => (
    <TabsPrimitive.List ref={ref} className={cn(tabsListVariants({ variant }), className)} {...props} />
  )
);
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & VariantProps<typeof tabsTriggerVariants>
>(({ className, variant, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(tabsTriggerVariants({ variant }), className)}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-2", FOCUS_RING_CLASS, className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
