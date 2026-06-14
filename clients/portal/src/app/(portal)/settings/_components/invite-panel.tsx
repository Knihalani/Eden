"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Loader2, Mail, X, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Invitation } from "@/lib/types";

interface InvitePanelProps {
  orgId: string;
  canManage: boolean;
}

export function InvitePanel({ orgId, canManage }: InvitePanelProps) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInvitations = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listInvitations(orgId);
      setInvitations(data);
    } catch (e: any) {
      setError(e.message || "Failed to load invitations");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (orgId) {
      loadInvitations();
    }
  }, [orgId]);

  const handleDecline = async (invitationId: string) => {
    if (!confirm("Are you sure you want to cancel this invitation?")) return;
    try {
      await api.declineInvite(orgId, invitationId);
      await loadInvitations();
    } catch (e: any) {
      alert(e.message || "Failed to cancel invitation");
    }
  };

  if (!canManage) return null;

  return (
    <div className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border)]">
      <div className="flex items-center gap-2 mb-4">
        <Mail className="w-4 h-4 text-[var(--text-muted)]" />
        <h3 className="text-sm font-semibold">Pending Invitations</h3>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
        </div>
      )}

      {error && (
        <div className="text-sm text-[var(--error)] py-2">{error}</div>
      )}

      {!loading && invitations.length === 0 && (
        <p className="text-sm text-[var(--text-muted)] py-4 text-center">
          No pending invitations
        </p>
      )}

      {!loading && invitations.length > 0 && (
        <div className="space-y-3">
          {invitations.map((invite) => (
            <div
              key={invite.id}
              className="flex items-center justify-between p-3 bg-[var(--bg-muted)] rounded-lg"
            >
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{invite.email}</span>
                <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                  <span className={cn(
                    "px-1.5 py-0.5 rounded font-medium",
                    invite.role === "admin" ? "bg-[var(--accent-faint)] text-[var(--accent)]" :
                    invite.role === "member" ? "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" :
                    "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                  )}>
                    {invite.role}
                  </span>
                  <span>Invited by {invite.inviter_name}</span>
                </div>
                <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                  <Clock className="w-3 h-3" />
                  <span>Expires {new Date(invite.expires_at).toLocaleDateString()}</span>
                </div>
              </div>
              <button
                onClick={() => handleDecline(invite.id)}
                className="p-2 text-[var(--error)] hover:bg-[var(--error-dim)] rounded-lg"
                title="Cancel invitation"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}