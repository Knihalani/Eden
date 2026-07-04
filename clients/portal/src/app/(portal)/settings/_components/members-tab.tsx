"use client";

/**
 * MembersTab — extracted from settings/page.tsx (June 2026 Phase 5).
 * List org members + invite form + pending invitations.
 */

import { useEffect, useState } from "react";
import { Trash2, Users, Shield, ShieldOff } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/settings-card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
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
      two_factor_enabled?: boolean;
    }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");

  // P9: client-side email validation. The backend rejects bad
  // addresses with a 422, but the user wouldn't see the error
  // until after they clicked Invite and waited on the network.
  // Cheap regex; covers the common cases (missing @, no domain,
  // spaces) — RFC 5322 validation happens server-side.
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isValidEmail = emailRegex.test(inviteEmail.trim());

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
      toast.error(err instanceof Error ? err.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMembers();
     
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

  type Member = (typeof members)[number];
  const columns: DataTableColumn<Member>[] = [
    { key: "name", header: "Name", sortable: true, sticky: true, cell: (m) => <span className="font-medium">{m.name}</span> },
    { key: "email", header: "Email", sortable: true },
    {
      key: "role",
      header: "Role",
      sortable: true,
      cell: (m) => (
        <span
          className={cn(
            "px-2 py-1 rounded-md text-sm font-medium",
            m.role === "owner"
              ? "bg-[var(--warning-bg)] text-[var(--warning)]"
              : m.role === "admin"
              ? "bg-[var(--accent-faint)] text-[var(--accent)]"
              : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
          )}
        >
          {m.role}
        </span>
      ),
    },
    // P11: 2FA status column. Shown as a shield icon + accessible
    // label so admins can see who's protected when the org has
    // ``two_factor_enforced`` set. The cell is sortable via the
    // boolean coercion.
    {
      key: "two_factor_enabled",
      header: "2FA",
      sortable: true,
      cell: (m) => (
        <span
          // The label is hidden visually but available to AT — the
          // shield icon is the primary indicator.
          aria-label={m.two_factor_enabled ? "Two-factor enabled" : "Two-factor disabled"}
          title={m.two_factor_enabled ? "Two-factor enabled" : "Two-factor disabled"}
          className={cn(
            "inline-flex items-center justify-center w-6 h-6 rounded-md",
            m.two_factor_enabled
              ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
              : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
          )}
        >
          {m.two_factor_enabled ? (
            <Shield className="w-3.5 h-3.5" />
          ) : (
            <ShieldOff className="w-3.5 h-3.5" />
          )}
        </span>
      ),
    },
    {
      key: "joined_at",
      header: "Joined",
      sortable: true,
      cell: (m) => new Date(m.joined_at).toLocaleDateString(),
      className: "text-[var(--text-muted)] text-sm",
    },
    {
      key: "last_active_at",
      header: "Last Active",
      sortable: true,
      cell: (m) => formatRelativeTime(m.last_active_at),
      className: "text-[var(--text-muted)] text-sm",
    },
    {
      key: "user_id",
      header: "",
      align: "right",
      cell: (m) =>
        m.role !== "owner" ? (
          <button
            onClick={() => handleRemove(m.user_id)}
            className="p-2 text-[var(--error)] hover:bg-[var(--error-dim)] rounded-lg"
            aria-label={`Remove ${m.name} from organization`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      {hasPermission("members:invite") && (
        <SettingsCard title="Invite member">
          <div className="space-y-2">
            <div className="flex gap-3">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@example.com"
                aria-label="Email address"
                aria-invalid={inviteEmail.trim() !== "" && !isValidEmail ? "true" : undefined}
                aria-describedby="invite-email-error"
                className={cn(
                  "flex-1 px-3 py-2 rounded-lg border bg-[var(--bg-secondary)] text-[var(--text-primary)]",
                  inviteEmail.trim() !== "" && !isValidEmail
                    ? "border-[var(--error)]"
                    : "border-[var(--border-default)]",
                )}
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
                disabled={!isValidEmail}
                aria-disabled={!isValidEmail || undefined}
                className="px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Invite
              </button>
            </div>
            {inviteEmail.trim() !== "" && !isValidEmail && (
              <p
                id="invite-email-error"
                role="alert"
                className="text-xs text-[var(--error)]"
              >
                Enter a valid email address (e.g. user@example.com).
              </p>
            )}
          </div>
        </SettingsCard>
      )}

      <SettingsCard contentClassName="p-0">
        <DataTable
          columns={columns}
          rows={members}
          rowKey={(m) => m.user_id}
          loading={loading}
          defaultSort={{ key: "name", direction: "asc" }}
          emptyTitle="No members yet"
          emptyDescription={
            hasPermission("members:invite")
              ? "Use the invite form above to add your team."
              : undefined
          }
          emptyIcon={Users}
          pageSize={25}
        />
      </SettingsCard>

      <InvitePanel orgId={org.id} canManage={hasPermission("members:invite")} />
      {ConfirmDialog}
    </div>
  );
}
