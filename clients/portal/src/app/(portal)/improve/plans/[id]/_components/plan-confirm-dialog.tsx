"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  variant,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  variant: "danger" | "primary";
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <AlertTriangle
              className={cn(
                "h-5 w-5 mt-0.5 flex-shrink-0",
                variant === "danger" ? "text-[var(--error)]" : "text-[var(--accent)]",
              )}
              aria-hidden
            />
            <div className="flex-1 space-y-1.5">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              variant === "danger" &&
                "bg-[var(--error)] hover:bg-[var(--error)]/90 text-[var(--bg-primary)]",
            )}
          >
            {busy && <RefreshCw className="h-4 w-4 animate-spin mr-1" aria-hidden />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
