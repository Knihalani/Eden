"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { Copy, Link2, Trash2 } from "lucide-react";

interface TraceShareModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  traceId: string;
}

export function TraceShareModal({ open, onOpenChange, traceId }: TraceShareModalProps) {
  const toast = useToast();
  const { currentOrg } = useOrg();
  const [shares, setShares] = useState<Array<{
    id: string;
    label: string | null;
    expires_at: string | null;
    revoked_at: string | null;
  }>>([]);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadShares = useCallback(async () => {
    if (!currentOrg?.id || !traceId) return;
    setLoading(true);
    try {
      const res = await api.listTraceShares(currentOrg.id, traceId);
      setShares(res.shares ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load share links");
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, traceId, toast]);

  useEffect(() => {
    if (open) {
      setMintedUrl(null);
      void loadShares();
    }
  }, [open, loadShares]);

  const handleCreate = async () => {
    if (!currentOrg?.id) return;
    setCreating(true);
    try {
      const res = await api.createTraceShare(currentOrg.id, traceId, {
        base_url: typeof window !== "undefined" ? window.location.origin : undefined,
        expiry_days: 7,
      });
      if (res.url) {
        setMintedUrl(res.url);
        toast.success("Share link created — copy it now; it won't be shown again.");
      }
      await loadShares();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create share link");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (shareId: string) => {
    if (!currentOrg?.id) return;
    try {
      await api.revokeTraceShare(currentOrg.id, shareId);
      toast.success("Share link revoked");
      await loadShares();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke share");
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy link");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share trace</DialogTitle>
          <DialogDescription>
            Create a redacted public link for trace{" "}
            <span className="font-mono">{traceId.slice(0, 12)}…</span>.
            The full URL is shown once when minted.
          </DialogDescription>
        </DialogHeader>

        {mintedUrl && (
          <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-faint)]/20 p-3 space-y-2">
            <p className="text-xs font-medium text-[var(--text-secondary)]">One-time link</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs truncate text-[var(--text-primary)]">{mintedUrl}</code>
              <Button size="sm" variant="outline" onClick={() => void copyUrl(mintedUrl)}>
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2 max-h-48 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-[var(--text-muted)]">Loading shares…</p>
          ) : shares.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">No active share links.</p>
          ) : (
            shares.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[var(--bg-tertiary)]"
              >
                <div className="min-w-0">
                  <p className="text-sm text-[var(--text-primary)] truncate">
                    {s.label || s.id.slice(0, 8)}
                  </p>
                  {s.expires_at && (
                    <p className="text-xs text-[var(--text-muted)]">Expires {s.expires_at}</p>
                  )}
                </div>
                {!s.revoked_at && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleRevoke(s.id)}
                    aria-label="Revoke share"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-[var(--error)]" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => void handleCreate()} disabled={creating}>
            <Link2 className="w-3.5 h-3.5 mr-1.5" />
            {creating ? "Creating…" : "Create link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
