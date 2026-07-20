"use client";

import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { api } from "@/lib/api";
import { Loader2, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface DeleteOrgDialogProps {
  orgId: string;
  orgName: string;
  onDeleted: () => void;
}

export function DeleteOrgDialog({ orgId, orgName, onDeleted }: DeleteOrgDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.deleteOrg(orgId);
      setOpen(false);
      onDeleted();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e.message || "Failed to delete organization");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-sm border border-[var(--error)] text-[var(--error)] rounded-lg hover:bg-[var(--error-dim)] flex items-center gap-1.5"
      >
        <Trash2 className="w-4 h-4" aria-hidden />
        Delete
      </button>

      <DialogPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          if (!loading) setOpen(next);
        }}
      >
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
            aria-describedby="delete-org-description"
          >
            <div className="flex items-center justify-between mb-4">
              <DialogPrimitive.Title className="text-lg font-semibold">
                Permanently Delete Organization
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Description
              id="delete-org-description"
              className="text-sm text-[var(--text-secondary)] mb-4 space-y-2"
            >
              <p>
                Prefer <strong>Archive</strong> first. Archiving hides{" "}
                <strong>{orgName}</strong> from the org switcher and keeps data
                recoverable. Use permanent delete only when you are sure you no
                longer need this organization.
              </p>
              <p>
                Permanent deletion removes the organization and all associated
                data. This action cannot be undone.
              </p>
            </DialogPrimitive.Description>
            {error && (
              <div className="text-[var(--error)] text-sm p-2 bg-[var(--error-dim)] rounded mb-4" role="alert">
                {error}
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  className="px-4 py-2 text-sm border border-[var(--border)] rounded-lg hover:bg-[var(--bg-tertiary)]"
                  disabled={loading}
                >
                  Cancel
                </button>
              </DialogPrimitive.Close>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={loading}
                className={cn(
                  "px-4 py-2 text-sm text-[var(--bg-primary)] bg-[var(--error)] rounded-lg hover:bg-[var(--error)] flex items-center gap-2",
                  loading && "opacity-50"
                )}
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
                Delete Permanently
              </button>
            </div>

            <DialogPrimitive.Close
              className="absolute right-4 top-4 rounded-md p-1 text-[var(--text-muted)] opacity-70 transition-opacity hover:opacity-100 hover:bg-[var(--accent-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              aria-label="Close dialog"
              disabled={loading}
            >
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
