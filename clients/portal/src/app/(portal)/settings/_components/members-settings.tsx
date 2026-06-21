"use client";

import { useState, useEffect } from "react";
import { Trash2, Users } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/settings-card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { formatRelativeTime } from "@/lib/format";
import type { Organization } from "@/lib/types";
import { InvitePanel } from "./invite-panel";

interface Member {
  user_id: string;
  name: string;
  email: string;
  role: string;
  joined_at: string;
  last_active_at: string | null;
}

interface MembersSettingsProps {
  org: Organization | null;
}

export function MembersSettings({ org }: MembersSettingsProps) {
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");

  const loadMembers = async () => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.listOrgMembers(org.id);
      setMembers(data as Member[]);
    } catch {
      // Fall through with empty list
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate pattern: refetch on org change
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
      const message = err instanceof Error ? err.message : "Failed to send invitation";
      toast.error(message);
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
      const message = err instanceof Error ? err.message : "Failed to remove member";
      toast.error(message);
    }
  };

  if (!org) {
    return (
      <SettingsCard title="Members">
        <div className="text-center py-8 text-[var(--text-secondary)] text-sm">
          Select an organization above to manage its members.
        </div>
      </SettingsCard>
    );
  }

  const columns: DataTableColumn<Member>[] = [
    { key: "name", header: "Name", sortable: true, sticky: true, cell: (m) => <span className="font-medium text-[var(--text-primary)]">{m.name}</span> },
    { key: "email", header: "Email", sortable: true, cell: (m) => <span className="text-[var(--text-secondary)]">{m.email}</span> },
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
                ? "bg-[var(--accent-bg)] text-[var(--accent)]"
                : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
          )}
        >
          {m.role}
        </span>
      ),
    },
    {
      key: "joined_at",
      header: "Joined",
      sortable: true,
      cell: (m) => <span className="text-[var(--text-muted)] text-sm">{new Date(m.joined_at).toLocaleDateString()}</span>,
    },
    {
      key: "last_active_at",
      header: "Last Active",
      sortable: true,
      cell: (m) => <span className="text-[var(--text-muted)] text-sm">{m.last_active_at ? formatRelativeTime(m.last_active_at) : "Never"}</span>,
    },
    {
      key: "user_id",
      header: "",
      align: "right",
      cell: (m) =>
        m.role !== "owner" ? (
          <button
            onClick={() => handleRemove(m.user_id)}
            className="p-2 text-[var(--error)] hover:bg-[var(--error-bg)] rounded-lg"
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
        <SettingsCard
          title="Invite a member"
          description="Add teammates by email. They'll get a link to join."
        >
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="user@example.com"
              className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
            >
              <option value="viewer">Viewer</option>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              onClick={handleInvite}
              className="px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:opacity-90"
            >
              Invite
            </button>
          </div>
        </SettingsCard>
      )}

      <SettingsCard title="Members" description={`${members.length} active`}>
        <DataTable
          columns={columns}
          rows={members}
          rowKey={(m) => m.user_id}
          loading={loading}
          defaultSort={{ key: "name", direction: "asc" }}
          emptyTitle="No members yet"
          emptyDescription="Invite teammates to share environments and review output together."
          emptyIcon={Users}
          pageSize={25}
        />
      </SettingsCard>

      <InvitePanel orgId={org.id} canManage={hasPermission("members:invite")} />
      {ConfirmDialog}
    </div>
  );
}
