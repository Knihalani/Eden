"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-[var(--bg-base)]/50 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: "right" | "bottom" | "left";
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed z-50 flex flex-col bg-[var(--bg-primary)] border-[var(--border-default)] shadow-xl",
        "panel-enter focus:outline-none",
        side === "right" &&
          "inset-y-0 right-0 h-full w-full max-w-lg border-l",
        side === "left" &&
          "inset-y-0 left-0 h-full w-full max-w-lg border-r",
        side === "bottom" &&
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)]",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-3 top-3 rounded-lg p-2 min-h-[44px] min-w-[44px] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col gap-1 px-4 py-3 border-b border-[var(--border-default)] pr-12", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-base font-semibold text-[var(--text-primary)]", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-[var(--text-muted)]", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
};
