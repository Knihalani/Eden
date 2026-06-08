"use client";

import { useCallback, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string | null;
  variant?: "default" | "destructive";
  hideCancel?: boolean;
}

export function useConfirm() {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [resolver, setResolver] = useState<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setOptions(opts);
      setResolver(() => resolve);
      setOpen(true);
    });
  }, []);

  const handleClose = (value: boolean) => {
    setOpen(false);
    resolver?.(value);
    setResolver(null);
    setOptions(null);
  };

  const showCancel = !(options?.hideCancel || options?.cancelLabel === null);

  const ConfirmDialog = (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{options?.title}</DialogTitle>
          <DialogDescription>{options?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className={showCancel ? "gap-2 sm:gap-0" : ""}>
          {showCancel && (
            <Button type="button" variant="outline" onClick={() => handleClose(false)}>
              {options?.cancelLabel ?? "Cancel"}
            </Button>
          )}
          <Button
            type="button"
            variant={options?.variant === "destructive" ? "destructive" : "default"}
            onClick={() => handleClose(true)}
          >
            {options?.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, ConfirmDialog };
}
