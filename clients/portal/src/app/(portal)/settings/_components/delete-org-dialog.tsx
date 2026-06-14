"use client";

import { useState } from "react";
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
    } catch (e: any) {
      setError(e.message || "Failed to delete organization");
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-sm border border-[var(--error)] text-[var(--error)] rounded-lg hover:bg-[var(--error-dim)] flex items-center gap-1.5"
      >
        <Trash2 className="w-4 h-4" />
        Delete
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base)]/50">
      <div className="bg-[var(--bg-primary)] rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Permanently Delete Organization</h2>
          <button
            onClick={() => setOpen(false)}
            className="p-1 hover:bg-[var(--bg-tertiary)] rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-[var(--text-secondary)] mb-4">
          This will permanently delete <strong>{orgName}</strong> and all associated data.
          This action cannot be undone.
        </p>
        {error && (
          <div className="text-[var(--error)] text-sm p-2 bg-[var(--error-dim)] rounded mb-4">
            {error}
          </div>
        )}
        <div className="flex gap-3 justify-end">
          <button
            onClick={() => setOpen(false)}
            className="px-4 py-2 text-sm border border-[var(--border)] rounded-lg hover:bg-[var(--bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={loading}
            className={cn(
              "px-4 py-2 text-sm text-[var(--bg-primary)] bg-[var(--error)] rounded-lg hover:bg-[var(--error)] flex items-center gap-2",
              loading && "opacity-50"
            )}
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Delete Permanently
          </button>
        </div>
      </div>
    </div>
  );
}