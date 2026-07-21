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
import { AlertTriangle } from "lucide-react";
import type { Organization } from "@/lib/types";

interface TransferOwnershipDialogProps {
  org: Organization;
  member: {
    user_id: string;
    name: string;
    email: string;
    role: string;
  };
  onClose: () => void;
  onTransferred: () => void;
}

export function TransferOwnershipDialog({
  org,
  member,
  onClose,
  onTransferred,
}: TransferOwnershipDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTransfer = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.transferOwnership(org.id, member.user_id);
      onTransferred();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to transfer ownership");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !loading && onClose()}>
      <DialogContent
        className="max-w-md"
        aria-describedby="transfer-ownership-description"
        onInteractOutside={(e) => {
          if (loading) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (loading) e.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div className="p-3 bg-[var(--warning-bg)] rounded-lg shrink-0">
              <AlertTriangle className="w-6 h-6 text-[var(--warning)]" aria-hidden />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <DialogTitle>Transfer ownership</DialogTitle>
              <DialogDescription id="transfer-ownership-description">
                This action cannot be undone.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="p-4 bg-[var(--bg-muted)] rounded-lg">
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

        <div className="p-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]">
          <p className="text-sm text-[var(--text-primary)]">
            <strong>What happens next:</strong>
          </p>
          <ul className="mt-2 text-sm text-[var(--text-secondary)] space-y-1">
            <li>• {member.name} will become the new owner</li>
            <li>• You will become an admin of {org.name}</li>
            <li>• You will lose owner privileges but keep admin access</li>
          </ul>
        </div>

        {error ? (
          <div
            className="p-3 bg-[var(--error-dim)] border border-[var(--error)] rounded-lg"
            role="alert"
          >
            <p className="text-sm text-[var(--error)]">{error}</p>
          </div>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={loading}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleTransfer()}
            disabled={loading}
            loading={loading}
          >
            Transfer ownership
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
