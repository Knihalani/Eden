"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { Trash2 } from "lucide-react";

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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete workspace");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="border-[var(--error)] text-[var(--error)] hover:bg-[var(--error-dim)]"
      >
        <Trash2 className="w-4 h-4" aria-hidden />
        Delete
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!loading) setOpen(next);
        }}
      >
        <DialogContent
          className="max-w-md"
          aria-describedby="delete-org-description"
          onInteractOutside={(e) => {
            if (loading) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (loading) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Permanently delete workspace</DialogTitle>
            <DialogDescription id="delete-org-description" asChild>
              <div className="space-y-2">
                <p>
                  Prefer <strong>Archive</strong> first. Archiving hides{" "}
                  <strong>{orgName}</strong> from the workspace switcher and keeps data
                  recoverable. Use permanent delete only when you are sure you no longer
                  need this workspace.
                </p>
                <p>
                  Permanent deletion removes the workspace and all associated data. This
                  action cannot be undone.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <div
              className="text-[var(--error)] text-sm p-2 bg-[var(--error-dim)] rounded"
              role="alert"
            >
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={loading}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={loading}
              loading={loading}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
