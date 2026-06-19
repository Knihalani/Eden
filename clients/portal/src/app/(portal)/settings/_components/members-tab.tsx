"use client";

/**
 * MembersTab — extracted from settings/page.tsx (June 2026 Phase 5).
 * List org members + invite form + pending invitations.
 */

import { useEffect, useState } from "react";
import { Loader2, Trash2, Users } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsCard } from "@/components/settings/settings-card";
import { InvitePanel } from "./invite-panel";

interface MembersTabProps {
  org: { id: string; name: string; role: string } | null;
}

export function MembersTab({ org }: MembersTabProps) {
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [members, setMembers] = useState<
    Array<{
      user_id: string;
      name: string;
      email: string;
      role: string;
      joined_at: string;
      last_active_at: string | null;
    }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");

  const formatRelativeTime = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const loadMembers = async () => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.listOrgMembers(org.id);
      setMembers(data as typeof members);
    } catch (err) {
      console.error("Failed to load members", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  const handleInvite = async () => {
    if (!org || !inviteEmail.trim()) return;
    try {
      await api.inviteOrgMember(org.id, inviteEmail, inviteRole);
      setInviteEmail("");
      await loadMembers();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to send invitation");
    }
  };

  const handleRemove = async (userId: string) => {
    if (!org) return;
    if (
      !(await confirm({
        title: "Remove member",
        description: "Are you sure you want to remove this member from the organization?",
        confirmLabel: "Remove",
        variant: "destructive",
      }))
    )
      return;
    try {
      await api.removeOrgMember(org.id, userId);
      await loadMembers();
      toast.success("Member removed");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to remove member");
    }
  };

  if (!org) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage members
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hasPermission("members:invite") && (
        <SettingsCard title="Invite member">
          <div className="flex gap-3">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="user@example.com"
              aria-label="Email address"
              className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              aria-label="Role"
              className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
            >
              <option value="viewer">Viewer</option>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              onClick={handleInvite}
              className="px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:opacity-90"
            >
              Invite
            </button>
          </div>
        </SettingsCard>
      )}

      <SettingsCard contentClassName="p-0">
        <table className="w-full">
          <thead className="bg-[var(--bg-tertiary)]">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)] sticky left-0 bg-[var(--bg-tertiary)]">
                Name
              </th>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">
                Email
              </th>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Role</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Joined</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Last Active</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="border-t border-[var(--border-default)]">
                  <td className="px-4 py-3" colSpan={6}>
                    <Skeleton className="h-4 w-full" />
                  </td>
                </tr>
              ))
            ) : members.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <Users className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)]" />
                  <p className="text-sm text-[var(--text-secondary)]">No members yet</p>
                  {hasPermission("members:invite") && (
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                      Use the invite form above to add your team.
                    </p>
                  )}
                </td>
              </tr>
            ) : (
              members.map((member) => (
                <tr
                  key={member.user_id}
                  className="border-t border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]/30"
                >
                  <td className="px-4 py-3 text-[var(--text-primary)] sticky left-0 bg-[var(--bg-primary)]">
                    {member.name}
                  </td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">{member.email}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "px-2 py-1 rounded-md text-sm font-medium",
                        member.role === "owner"
                          ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                          : member.role === "admin"
                          ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                          : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                      )}
                    >
                      {member.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-muted)] text-sm">
                    {new Date(member.joined_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-[var(--text-muted)] text-sm">
                    {formatRelativeTime(member.last_active_at)}
                  </td>
                  <td className="px-4 py-3">
                    {member.role !== "owner" && (
                      <button
                        onClick={() => handleRemove(member.user_id)}
                        className="p-2 text-[var(--error)] hover:bg-[var(--error-dim)] rounded-lg"
                        aria-label={`Remove ${member.name} from organization`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </SettingsCard>

      <InvitePanel orgId={org.id} canManage={hasPermission("members:invite")} />
      {ConfirmDialog}
    </div>
  );
}
