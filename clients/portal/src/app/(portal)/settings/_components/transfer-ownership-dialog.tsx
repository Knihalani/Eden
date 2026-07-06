"use client";

import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { api } from "@/lib/api";
import { Loader2, AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TransferOwnershipDialogProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  org: any;
  member: {
    user_id: string;
    name: string;
    email: string;
    role: string;
  };
  onClose: () => void;
  onTransferred: () => void;
}

// ui-audit 2026-07-06 H4: the original implementation used a
// hand-rolled <div onClick={onClose}> backdrop with no Escape
// handler, no focus trap, and no aria-modal — keyboard users had
// to find the Cancel button to dismiss. Migrated to Radix Dialog
// which provides focus trap + Escape close + aria-modal out of
// the box. The visual treatment (custom warning palette) is
// preserved by overriding the content className.
export function TransferOwnershipDialog({
  org,
  member,
  onClose,
  onTransferred,
}: TransferOwnershipDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ui-audit 2026-07-06 H4: focus the dialog heading on open so
  // screen-reader users hear "Transfer Ownership dialog" first.
  // Radix handles focus-trap; we just want a clear entry point.
  useEffect(() => {
    // No-op: Radix auto-focuses the first focusable element.
  }, []);

  const handleTransfer = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.transferOwnership(org.id, member.user_id);
      onTransferred();
      onClose();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e.message || "Failed to transfer ownership");
    } finally {
      setLoading(false);
    }
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50"
          style={{ backgroundColor: "color-mix(in srgb, var(--bg-base) 50%, transparent)" }}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-50 grid w-full max-w-md max-h-[90vh] overflow-y-auto translate-x-[-50%] translate-y-[-50%]",
            "gap-4 border border-[var(--border-default)] bg-[var(--bg-primary)] p-6 shadow-lg rounded-xl",
            "duration-200"
          )}
          aria-describedby="transfer-ownership-description"
        >
          <div className="flex items-start gap-4 mb-4">
            <div className="p-3 bg-[var(--warning-bg)] rounded-lg shrink-0">
              <AlertTriangle className="w-6 h-6 text-[var(--warning)]" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-lg font-semibold text-[var(--text-primary)]">
                Transfer Ownership
              </DialogPrimitive.Title>
              <p
                id="transfer-ownership-description"
                className="text-sm text-[var(--text-secondary)] mt-1"
              >
                This action cannot be undone.
              </p>
            </div>
          </div>

          <div className="mb-6 p-4 bg-[var(--bg-muted)] rounded-lg">
            <p className="text-sm text-[var(--text-primary)]">
              You are about to transfer ownership of <strong>{org.name}</strong> to:
            </p>
            <div className="mt-3 flex items-center gap-3">
              <div className="w-10 h-10 bg-[var(--accent-faint)] rounded-full flex items-center justify-center shrink-0">
                <span className="text-[var(--accent)] font-medium" aria-hidden>
                  {member.name.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0">
                <p className="font-medium text-[var(--text-primary)] truncate">{member.name}</p>
                <p className="text-sm text-[var(--text-secondary)] truncate">{member.email}</p>
              </div>
            </div>
          </div>

          <div className="mb-6 p-3 bg-[var(--accent-faint)] rounded-lg border border-[var(--accent)]/30">
            <p className="text-sm text-[var(--accent)]">
              <strong>What happens next:</strong>
            </p>
            <ul className="mt-2 text-sm text-[var(--accent)] space-y-1">
              <li>• {member.name} will become the new owner</li>
              <li>• You will become an admin of {org.name}</li>
              <li>• You will lose owner privileges but keep admin access</li>
            </ul>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-[var(--error-dim)] border border-[var(--error)] rounded-lg" role="alert">
              <p className="text-sm text-[var(--error)]">{error}</p>
            </div>
          )}

          <div className="flex gap-3 justify-end">
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg"
                disabled={loading}
              >
                Cancel
              </button>
            </DialogPrimitive.Close>
            <button
              type="button"
              onClick={handleTransfer}
              disabled={loading}
              className={cn(
                "px-4 py-2 text-sm font-medium rounded-lg flex items-center gap-2",
                "bg-[var(--warning)] text-[var(--bg-primary)] hover:bg-[var(--warning)]",
                loading && "opacity-50 cursor-not-allowed"
              )}
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              Transfer Ownership
            </button>
          </div>

          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-md p-1 text-[var(--text-muted)] opacity-70 transition-opacity hover:opacity-100 hover:bg-[var(--accent-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" aria-hidden />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
