"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface TransferOwnershipDialogProps {
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
    } catch (e: any) {
      setError(e.message || "Failed to transfer ownership");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[var(--bg-base)]/50" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-[var(--bg-primary)] rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-start gap-4 mb-4">
          <div className="p-3 bg-[var(--warning-bg)] rounded-lg">
            <AlertTriangle className="w-6 h-6 text-[var(--warning)]" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Transfer Ownership
            </h2>
            <p className="text-sm text-[var(--text-secondary)] mt-1">
              This action cannot be undone.
            </p>
          </div>
        </div>

        <div className="mb-6 p-4 bg-[var(--bg-muted)] rounded-lg">
          <p className="text-sm text-[var(--text-primary)]">
            You are about to transfer ownership of <strong>{org.name}</strong> to:
          </p>
          <div className="mt-3 flex items-center gap-3">
            <div className="w-10 h-10 bg-[var(--accent-faint)] rounded-full flex items-center justify-center">
              <span className="text-[var(--accent)] font-medium">
                {member.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <p className="font-medium text-[var(--text-primary)]">{member.name}</p>
              <p className="text-sm text-[var(--text-secondary)]">{member.email}</p>
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
          <div className="mb-4 p-3 bg-[var(--error-dim)] border border-[var(--error)] rounded-lg">
            <p className="text-sm text-[var(--error)]">{error}</p>
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            onClick={handleTransfer}
            disabled={loading}
            className={cn(
              "px-4 py-2 text-sm font-medium rounded-lg flex items-center gap-2",
              "bg-[var(--warning)] text-[var(--bg-primary)] hover:bg-[var(--warning)]",
              loading && "opacity-50 cursor-not-allowed"
            )}
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Transfer Ownership
          </button>
        </div>
      </div>
    </div>
  );
}