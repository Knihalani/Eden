"use client";

/**
 * Pending invitations list — team workspaces only when ``canManage``.
 * Refreshes when ``refreshKey`` bumps after a successful invite.
 */

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { Loader2, X, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { SettingsCard } from "@/components/settings/settings-card";
import type { Invitation } from "@/lib/types";

interface InvitePanelProps {
  orgId: string;
  canManage: boolean;
  /** Bump after invite create so pending list stays coherent with the form. */
  refreshKey?: number;
}

export function InvitePanel({
  orgId,
  canManage,
  refreshKey = 0,
}: InvitePanelProps) {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInvitations = useCallback(async () => {
    if (!orgId || !canManage) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listInvitations(orgId);
      setInvitations(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load invitations");
    } finally {
      setLoading(false);
    }
  }, [orgId, canManage]);

  useEffect(() => {
    void loadInvitations();
  }, [loadInvitations, refreshKey]);

  const handleDecline = async (invitationId: string) => {
    const ok = await confirm({
      title: "Cancel this invitation?",
      description: "The invitee will no longer be able to join with this link.",
      confirmLabel: "Cancel invitation",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.declineInvite(orgId, invitationId);
      await loadInvitations();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to cancel invitation");
    }
  };

  if (!canManage) return null;

  return (
    <SettingsCard title="Pending invitations" description="Invites waiting to be accepted.">
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" aria-label="Loading invitations" />
        </div>
      )}

      {error && !loading && (
        <ErrorState
          title="Could not load invitations"
          message={error}
          action={
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void loadInvitations()}
            >
              Try again
            </Button>
          }
        />
      )}

      {!loading && !error && invitations.length === 0 && (
        <p className="text-sm text-[var(--text-muted)] py-4 text-center">
          No pending invitations
        </p>
      )}

      {!loading && !error && invitations.length > 0 && (
        <div className="space-y-space-3">
          {invitations.map((invite) => (
            <div
              key={invite.id}
              className="flex items-center justify-between p-3 bg-[var(--bg-muted)] rounded-lg"
            >
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm font-medium truncate">{invite.email}</span>
                <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded font-medium",
                      invite.role === "admin"
                        ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
                    )}
                  >
                    {invite.role}
                  </span>
                  <span>Invited by {invite.inviter_name}</span>
                </div>
                <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                  <Clock className="w-3 h-3" aria-hidden />
                  <span>
                    Expires {new Date(invite.expires_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => void handleDecline(invite.id)}
                className="text-[var(--error)] hover:bg-[var(--error-dim)] shrink-0"
                aria-label={`Cancel invitation for ${invite.email}`}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {ConfirmDialog}
    </SettingsCard>
  );
}
