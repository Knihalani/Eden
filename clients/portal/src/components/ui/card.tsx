"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const cardVariants = cva(
  // `overflow-hidden` so long content (esp. with `rounded-xl`) can't
  // bleed past the corners; matches StatCard's contract so a grid
  // mixing Card and StatCard produces even rows. June 2026 fix.
  "rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm overflow-hidden",
  {
    variants: {
      variant: {
        default: "",
        elevated: "bg-[var(--bg-secondary)] shadow-md",
        inset: "bg-[var(--bg-inset)]",
        interactive:
          "transition-all duration-200 ease-out card-hover-lift cursor-pointer hover:border-[var(--border-strong)]" },
      padding: {
        none: "",
        sm: "p-3",
        md: "p-4",
        lg: "p-5",
        xl: "p-6" } },
    defaultVariants: {
      variant: "default",
      padding: "lg" } }
);

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

/**
 * Card — supports the `as` prop so semantic-rooted wrappers
 * (e.g. `<Card as="section">` for settings section roots) keep their
 * element type. Falls back to a div. June 2026 polish round.
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

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-5", className)} {...props} />
  )
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("text-lg font-semibold leading-none tracking-tight text-[var(--text-primary)]", className)}
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

// ponytail: CardContent and CardFooter respect the same `padding`
// variant as the outer Card. The default is `lg` to match the
// previous hardcoded `p-5 pt-0`; callers can pass `padding="none"`
// to opt out when the Card's own padding is enough.
const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardVariants>
>(({ className, padding, ...__props }, ref) => {
  const { padding: _outer, ...content } = { padding };
  void _outer;
  return (
    <div
      ref={ref}
      className={cn(cardVariants({ padding, className }), "shadow-none border-0 bg-transparent")}
      {...content}
    />
  );
});
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardVariants>
>(({ className, padding, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(cardVariants({ padding, className }), "flex items-center shadow-none border-0 bg-transparent")}
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
  cardVariants };
