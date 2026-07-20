"use client";

/**
 * MembersTab — extracted from settings/page.tsx (June 2026 Phase 5).
 * List org members + invite form + pending invitations.
 */

import { useState } from "react";
import Link from "next/link";
import { Trash2, Users, Shield, ShieldOff } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { errorFromCaught } from "@/lib/safe-error-message";
import { InvitePanel } from "./invite-panel";
import type { Organization } from "@/lib/types";

interface MembersTabProps {
  org: Organization | null;
}

export function MembersTab({ org }: MembersTabProps) {
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const { refreshOrgs, orgSyncing, orgSyncTimedOut } = useOrg();
  const orgId = org?.id ?? null;
  const isPersonal = Boolean(org?.is_personal);
  const canInvite = hasPermission("members:invite") && !isPersonal;
  // Remove is a separate permission from invite — viewers/members must
  // not see the trash control (backend 403s, but the UI must not tease).
  const canRemove = hasPermission("members:remove");
  const membersQuery = useOrgQuery(
    queryKeys.settings.members(orgId),
    orgId,
    () =>
      api.listOrgMembers(orgId!) as Promise<
        Array<{
          user_id: string;
          name: string;
          email: string;
          role: string;
          joined_at: string;
          last_active_at: string | null;
          two_factor_enabled?: boolean;
        }>
      >,
  );
  const members = membersQuery.data ?? [];
  const loading = membersQuery.isLoading;
  // Fail closed: 5xx must not paint as "No members yet".
  const loadError = membersQuery.error
    ? errorFromCaught(membersQuery.error, "Failed to load members")
    : null;
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);

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

  const handleInvite = async () => {
    if (!org || !inviteEmail.trim()) return;
    try {
      const res = await api.inviteOrgMember(org.id, inviteEmail, inviteRole);
      setInviteEmail("");
      setLastInviteUrl(res.invite_url ?? null);
      await membersQuery.refetch();
      if (res.invite_url) {
        toast.success("Invitation created", "Copy the invite link below to share.");
      } else {
        toast.success("Invitation sent");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to send invitation");
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    if (!org) return;
    try {
      await api.updateOrgMemberRole(org.id, userId, role);
      await membersQuery.refetch();
      toast.success("Role updated");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update role");
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
      await membersQuery.refetch();
      toast.success("Member removed");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to remove member");
    }
  };

  if (!org) {
    return (
      <NoOrgState
        feature="Members"
        icon={Users}
        syncing={orgSyncing && !orgSyncTimedOut}
        syncTimedOut={orgSyncTimedOut}
        onRetrySync={() => void refreshOrgs()}
        description={
          orgSyncTimedOut
            ? undefined
            : "Select or create an organization to manage members. The product tour does not sync your workspace."
        }
        secondaryAction={
          <Link
            href="/settings?tab=org"
            className="inline-flex min-h-11 items-center text-sm text-[var(--accent)] hover:underline"
          >
            Open Organization settings
          </Link>
        }
      />
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
      cell: (m) =>
        m.role === "owner" || !canInvite ? (
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
        ) : (
          <select
            aria-label={`Change role for ${m.name}`}
            value={m.role}
            onChange={(e) => void handleRoleChange(m.user_id, e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm"
          >
            <option value="admin">admin</option>
            <option value="member">member</option>
            <option value="viewer">viewer</option>
          </select>
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
        canRemove && m.role !== "owner" ? (
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
      {isPersonal && (
        <p className="text-sm text-[var(--text-muted)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-4 py-3">
          This is a personal workspace. Invites are unavailable — create a team
          organization under Organization settings to add members.
        </p>
      )}
      {canInvite && (
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
            {lastInviteUrl && (
              <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 space-y-2">
                <p className="text-xs text-[var(--text-muted)]">
                  Share this invite link (shown when email delivery is unavailable or as a backup):
                </p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={lastInviteUrl}
                    className="flex-1 px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-xs font-mono text-[var(--text-primary)]"
                    aria-label="Invite URL"
                  />
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs rounded-md bg-[var(--accent)] text-[var(--accent-foreground)]"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(lastInviteUrl);
                        toast.success("Invite link copied");
                      } catch {
                        toast.error("Could not copy link");
                      }
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>
        </SettingsCard>
      )}

      <SettingsCard contentClassName="p-0">
        {loadError ? (
          <div className="p-4">
            <ErrorState
              title="Could not load members"
              message={loadError}
              action={
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void membersQuery.refetch()}
                >
                  Try again
                </Button>
              }
            />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={members}
            rowKey={(m) => m.user_id}
            loading={loading}
            defaultSort={{ key: "name", direction: "asc" }}
            emptyTitle="No members yet"
            emptyDescription={
              canInvite
                ? "Use the invite form above to add your team."
                : undefined
            }
            emptyIcon={Users}
            pageSize={25}
          />
        )}
      </SettingsCard>

      {canInvite && <InvitePanel orgId={org.id} canManage />}
      {ConfirmDialog}
    </div>
  );
}
