"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Card — bordered surface for interactive islands or true containers
 * (clickable rows, form shells, discrete widgets). Prefer Panel for
 * non-interactive grouping so pages do not stack border-on-border.
 * Do not nest Card inside Card; flatten with Panel or open background.
 *
 * Padding contract: use root `padding` for simple children, OR set
 * `padding="none"` and let CardHeader / CardContent own inset — never
 * both, or you get double-padding.
 */
const cardVariants = cva(
  // `overflow-hidden` so long content (esp. with `rounded-xl`) can't
  // bleed past the corners; matches StatCard's contract so a grid
  // mixing Card and StatCard produces even rows.
  "rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-hidden",
  {
    variants: {
      variant: {
        default: "",
        elevated: "bg-[var(--bg-secondary)] border-[var(--border-strong)]",
        inset: "bg-[var(--bg-inset)]",
        interactive:
          "transition-all duration-200 ease-out card-hover-lift cursor-pointer hover:border-[var(--border-strong)]",
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
      variant: "default",
      // md is the default inset — enough air without inviting
      // card-in-card / Header+root double-pad.
      padding: "md",
    },
  }
);

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

/**
 * Card — supports the `as` prop so semantic-rooted wrappers
 * (e.g. `<Card as="section">` for settings section roots) keep their
 * element type. Falls back to a div.
 */
const Card = React.forwardRef<HTMLElement, CardProps & { as?: React.ElementType }>(
  ({ className, variant, padding, as: As = "div", ...props }, ref) => {
    const AsComponent = As as React.ElementType;
    return (
      <AsComponent
        ref={ref as React.Ref<HTMLElement>}
        className={cn(cardVariants({ variant, padding }), className)}
        {...props}
      />
    );
  }
);
Card.displayName = "Card";

const cardPadVariants = cva("", {
  variants: {
    padding: {
      none: "",
      sm: "p-3",
      md: "p-4",
      lg: "p-5",
      xl: "p-6",
    },
  },
  defaultVariants: {
    padding: "md",
  },
});

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardPadVariants>
>(({ className, padding = "md", ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1", cardPadVariants({ padding }), className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("text-base font-semibold leading-none tracking-tight text-[var(--text-primary)]", className)}
      {...props}
    />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-sm text-[var(--text-secondary)]", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardPadVariants>
>(({ className, padding = "md", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(cardPadVariants({ padding }), "pt-0", className)}
    {...props}
  />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardPadVariants>
>(({ className, padding = "md", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(cardPadVariants({ padding }), "flex items-center pt-0", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  cardVariants,
};
