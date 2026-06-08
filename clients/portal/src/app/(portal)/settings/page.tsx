"use client";

import { useState, useEffect, useRef } from "react";
import { useOrg } from "@/hooks/use-org";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { Loader2, Plus, Trash2, Building2, Users, Code, Copy, Check, Archive, RefreshCw, Key, FileText, Shield, CreditCard, KeyRound, Lock, BarChart2, FileArchive } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { DeleteOrgDialog } from "./_components/delete-org-dialog";
import { TransferOwnershipDialog } from "./_components/transfer-ownership-dialog";
import { InvitePanel } from "./_components/invite-panel";
import { AuditLogTab } from "./_components/audit-log-tab";
import { AnalyticsTab } from "./_components/analytics-tab";
import { DataExportPanel } from "./_components/data-export-panel";
import { ExportsTab } from "./_components/exports-tab";
import { SecurityTab } from "./_components/security-tab";
import { ScimTab } from "./_components/scim-tab";
import { SSOTab } from "./_components/sso-tab";
import { BillingTab } from "./_components/billing-tab";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { Skeleton } from "@/components/ui/skeleton";

type Tab = "org" | "members" | "references" | "api-keys" | "security" | "scim" | "sso" | "audit-log" | "analytics" | "billing" | "exports";

const TABS = [
  { id: "org", label: "Organization", icon: Building2 },
  { id: "members", label: "Members", icon: Users },
  { id: "references", label: "Code References", icon: Code },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "security", label: "Security", icon: Shield },
  { id: "scim", label: "SCIM", icon: KeyRound },
  { id: "sso", label: "SSO", icon: Lock },
  { id: "exports", label: "Exports", icon: FileArchive },
  { id: "audit-log", label: "Audit Log", icon: FileText },
  { id: "analytics", label: "Analytics", icon: BarChart2 },
  { id: "billing", label: "Billing", icon: CreditCard },
] as const;

export default function SettingsPage() {
  const { user } = useAuth();
  const { currentOrg, organizations, setCurrentOrg, refreshOrgs } = useOrg();
  const [activeTab, setActiveTab] = useState<Tab>("org");
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({});
  const navRef = useRef<HTMLDivElement>(null);

  // Update sliding indicator position
  useEffect(() => {
    const updateIndicator = () => {
      const nav = navRef.current;
      if (!nav) return;
      const activeButton = nav.querySelector(`[data-tab-id="${activeTab}"]`) as HTMLButtonElement;
      if (!activeButton) return;
      const navRect = nav.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();
      const top = buttonRect.top - navRect.top + 4; // 4px padding adjustment
      const height = buttonRect.height - 8; // 8px total padding adjustment
      setIndicatorStyle({
        transform: `translateY(${top}px)`,
        height: `${height}px`,
        width: 'calc(100% - var(--space-4))',
        left: 'var(--space-2)',
      });
    };

    updateIndicator();
    // Use ResizeObserver to handle responsive layout changes
    const resizeObserver = new ResizeObserver(updateIndicator);
    if (navRef.current) {
      resizeObserver.observe(navRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [activeTab]);

  if (!user) return null;

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-4rem)]">
      {/* Tab rail: horizontal scroll on mobile, vertical on lg */}
      <div className="w-full lg:w-[200px] flex-shrink-0 bg-[var(--bg-primary)] border-b lg:border-b-0 lg:border-r border-[var(--border-default)]">
        <div className="p-3 lg:p-4">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2 lg:mb-4 px-2">Settings</h2>
          <nav ref={navRef} className="flex flex-row lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0 -mx-1 px-1 lg:mx-0 lg:px-0 relative" role="tablist" aria-label="Settings sections">
            {/* Sliding frosted glass indicator */}
            <div
              className="absolute hidden lg:block rounded-lg border border-[var(--indicator-border)] bg-[var(--indicator-bg)] backdrop-blur-[var(--indicator-blur)] pointer-events-none transition-all duration-300 ease-out z-0"
              style={indicatorStyle}
              aria-hidden="true"
            />
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                data-tab-id={tab.id}
                aria-selected={activeTab === tab.id}
                id={`settings-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id as Tab)}
                className={cn(
                  "flex-shrink-0 lg:w-full px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 lg:gap-3 transition-colors whitespace-nowrap relative z-10",
                  activeTab === tab.id
                    ? "text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                )}
              >
                <tab.icon className="w-4 h-4 flex-shrink-0" aria-hidden />
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto min-h-0">
        <div className="p-4 sm:p-6 max-w-4xl mx-auto">
          {/* Org Switcher */}
          {organizations.length > 0 && (
            <div className="mb-6 p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
              <div className="flex items-center gap-3 mb-3">
                <Building2 className="w-5 h-5 text-[var(--text-muted)]" />
                <span className="text-sm font-medium text-[var(--text-primary)]">Current Organization</span>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <label htmlFor="settings-org-select" className="sr-only">
                  Current organization
                </label>
                <select
                  id="settings-org-select"
                  value={currentOrg?.id || ""}
                  onChange={(e) => {
                    const org = organizations.find((o) => o.id === e.target.value);
                    setCurrentOrg(org || null);
                  }}
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                >
                  {organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name} ({org.role})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Tab Content */}
          <div className="page-enter" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
            {activeTab === "org" && <OrgSettings org={currentOrg} />}
            {activeTab === "members" && <MembersSettings org={currentOrg} />}
            {activeTab === "references" && <ReferencesSettings org={currentOrg} />}
            {activeTab === "api-keys" && <ApiKeysSettings org={currentOrg} />}
            {activeTab === "security" && <SecurityTab />}
            {activeTab === "scim" && <ScimTab org={currentOrg} />}
            {activeTab === "sso" && <SSOTab orgId={currentOrg?.id || ""} />}
            {activeTab === "audit-log" && <AuditLogTab org={currentOrg} />}
            {activeTab === "analytics" && <AnalyticsTab />}
            {activeTab === "billing" && <BillingTab />}
            {activeTab === "exports" && (
              <ExportsTab
                orgId={currentOrg?.id || ""}
                canManage={currentOrg?.role === "owner" || currentOrg?.role === "admin"}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OrgSettings({ org }: { org: any }) {
  const { refreshOrgs } = useOrg();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(org?.name || "");
  const [showCreate, setShowCreate] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");

  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return;
    setLoading(true);
    try {
      await api.createOrg(newOrgName);
      setNewOrgName("");
      setShowCreate(false);
      await refreshOrgs();
    } catch (e) {
      toast.error("Failed to create organization");
    } finally {
      setLoading(false);
    }
  };

  if (!org && !showCreate) {
    return (
      <div className="text-center py-12">
        <Building2 className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
        <p className="text-[var(--text-secondary)] mb-4">No organization yet</p>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity flex items-center gap-2 mx-auto"
        >
          <Plus className="w-4 h-4" />
          Create Organization
        </button>
      </div>
    );
  }

  if (showCreate) {
    return (
      <div className="p-6 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
        <h2 className="text-lg font-semibold mb-4">Create Organization</h2>
        <input
          type="text"
          value={newOrgName}
          onChange={(e) => setNewOrgName(e.target.value)}
          placeholder="Organization name"
          className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] mb-4"
        />
        <div className="flex gap-2 justify-end">
          <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={handleCreateOrg}
            disabled={loading}
            className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create Organization"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="p-6 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
        <h2 className="text-lg font-semibold mb-4">Organization Details</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Slug</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={org?.slug || ""}
                disabled
                className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)]"
              />
              <button
                onClick={() => navigator.clipboard.writeText(org?.slug || "")}
                className="p-2 hover:bg-[var(--bg-tertiary)] rounded-lg"
                title="Copy slug"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="pt-2">
            <span className="text-sm font-medium text-[var(--text-secondary)]">Role: </span>
            <span className={cn(
              "px-2 py-1 rounded-md text-sm font-medium",
              org?.role === "owner" ? "bg-yellow-100 text-yellow-800" :
              org?.role === "admin" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-700"
            )}>
              {org?.role}
            </span>
          </div>

          {/* Archive/Delete actions for admins/owners */}
          {(org?.role === "owner" || org?.role === "admin") && (
            <div className="pt-4 border-t border-[var(--border-default)] flex items-center gap-3">
              <button
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: "Archive organization",
                      description: `Archive ${org.name}? It will be hidden from the org switcher.`,
                      confirmLabel: "Archive",
                      variant: "destructive",
                    }))
                  )
                    return;
                  try {
                    await api.archiveOrg(org.id);
                    await refreshOrgs();
                    toast.success("Organization archived");
                  } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : "Failed to archive organization";
                    toast.error(message);
                  }
                }}
                className="px-3 py-1.5 text-sm border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] flex items-center gap-1.5"
              >
                <Archive className="w-4 h-4" />
                Archive
              </button>
              {org?.role === "owner" && (
                <>
                  <DeleteOrgDialog
                    orgId={org.id}
                    orgName={org.name}
                    onDeleted={async () => {
                      await refreshOrgs();
                    }}
                  />
                  <TransferOwnershipSection org={org} />
                </>
              )}
              {/* Data Export for admins/owners */}
              <DataExportPanel orgId={org.id} canExport={true} />
            </div>
          )}
        </div>
      </div>
      {ConfirmDialog}
    </div>
  );
}

function MembersSettings({ org }: { org: any }) {
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [members, setMembers] = useState<any[]>([]);
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
      setMembers(data);
    } catch (err) {
      console.error("Failed to load members", err);
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
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage members
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Invite Form */}
      {hasPermission("members:invite") && (
        <div className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
          <h3 className="text-sm font-semibold mb-3">Invite Member</h3>
          <div className="flex gap-3">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="user@example.com"
              className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)]"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[var(--border-default)]"
            >
              <option value="viewer">Viewer</option>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              onClick={handleInvite}
              className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:opacity-90"
            >
              Invite
            </button>
          </div>
        </div>
      )}

      {/* Members List */}
      <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] overflow-hidden">
        <table className="w-full">
          <thead className="bg-[var(--bg-tertiary)]">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Name</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Email</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Role</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Joined</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Last Active</th>
              <th></th>
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
                    <p className="text-xs text-[var(--text-muted)] mt-1">Use the invite form above to add your team.</p>
                  )}
                </td>
              </tr>
            ) : (
            members.map((member) => (
              <tr key={member.user_id} className="border-t border-[var(--border-default)]">
                <td className="px-4 py-3">{member.name}</td>
                <td className="px-4 py-3 text-[var(--text-secondary)]">{member.email}</td>
                <td className="px-4 py-3">
                  <span className={cn(
                    "px-2 py-1 rounded-md text-sm font-medium",
                    member.role === "owner" ? "bg-yellow-100 text-yellow-800" :
                    member.role === "admin" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-700"
                  )}>
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
                      className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
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
      </div>

      {/* Pending Invitations Panel */}
      <InvitePanel orgId={org.id} canManage={hasPermission("members:invite")} />
      {ConfirmDialog}
    </div>
  );
}

function ReferencesSettings({ org }: { org: any }) {
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [references, setReferences] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<{ purpose?: string; language?: string }>({});

  const loadReferences = async () => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.listReferences(org.id, filter);
      setReferences(data);
    } catch (e) {
      console.error("Failed to load references", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReferences();
  }, [org?.id, filter.purpose, filter.language]);

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!org) return;

    const formData = new FormData(e.currentTarget);
    setUploading(true);
    try {
      await api.uploadReference(org.id, formData);
      (e.target as HTMLFormElement).reset();
      await loadReferences();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to upload reference";
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (refId: string) => {
    if (
      !org ||
      !(await confirm({
        title: "Delete reference",
        description: "Delete this code reference? This cannot be undone.",
        confirmLabel: "Delete",
        variant: "destructive",
      }))
    )
      return;
    try {
      await api.deleteReference(org.id, refId);
      await loadReferences();
      toast.success("Reference deleted");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete";
      toast.error(message);
    }
  };

  if (!org) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage code references
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Upload Form - requires references:upload permission */}
      {hasPermission("references:upload") && (
        <div className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
          <h3 className="text-sm font-semibold mb-3">Upload Code Reference</h3>
          <form onSubmit={handleUpload} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <input
                name="name"
                placeholder="Display name"
                required
                className="px-3 py-2 rounded-lg border border-[var(--border-default)]"
              />
              <input
                name="purpose"
                placeholder="Purpose (e.g., Auth patterns)"
                required
                className="px-3 py-2 rounded-lg border border-[var(--border-default)]"
              />
            </div>
            <textarea
              name="description"
              placeholder="Description (optional)"
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)]"
            />
            <div className="flex gap-3">
              <input
                name="file"
                type="file"
                required
                accept=".py,.js,.ts,.tsx,.go,.rs,.java,.rb,.php,.c,.cpp,.cs,.swift,.kt,.sql,.sh,.yaml,.yml,.json,.md"
                className="flex-1 text-sm"
              />
              <button
                type="submit"
                disabled={uploading}
                className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Upload
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={filter.purpose || ""}
          onChange={(e) => setFilter({ ...filter, purpose: e.target.value || undefined })}
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] text-sm"
        >
          <option value="">All purposes</option>
        </select>
        <select
          value={filter.language || ""}
          onChange={(e) => setFilter({ ...filter, language: e.target.value || undefined })}
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] text-sm"
        >
          <option value="">All languages</option>
          <option value="python">Python</option>
          <option value="javascript">JavaScript</option>
          <option value="typescript">TypeScript</option>
          <option value="go">Go</option>
          <option value="rust">Rust</option>
        </select>
      </div>

      {/* References List */}
      <div className="grid gap-3">
        {references.map((ref) => (
          <div key={ref.id} className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{ref.name}</span>
                <span className="px-2 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs">{ref.language}</span>
              </div>
              <p className="text-sm text-[var(--text-muted)] truncate">{ref.filename}</p>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 rounded">{ref.purpose}</span>
                {ref.description && (
                  <span className="text-xs text-[var(--text-secondary)]">{ref.description}</span>
                )}
              </div>
            </div>
            {hasPermission("references:delete") && (
              <button
                onClick={() => handleDelete(ref.id)}
                className="p-2 text-red-500 hover:bg-red-50 rounded-lg ml-4"
                title="Delete reference"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
        {references.length === 0 && !loading && (
          <div className="text-center py-12 text-[var(--text-secondary)]">
            <Code className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No code references yet</p>
            <p className="text-sm">Upload code examples to help Eden learn your patterns</p>
          </div>
        )}
      </div>
      {ConfirmDialog}
    </div>
  );
}

function TransferOwnershipSection({ org }: { org: any }) {
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedMember, setSelectedMember] = useState<any>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const { refreshOrgs } = useOrg();

  const loadMembers = async () => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.listOrgMembers(org.id);
      setMembers(data.filter((m: any) => m.role !== "owner"));
    } catch (e) {
      console.error("Failed to load members", e);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpanded = async () => {
    if (isExpanded) {
      setIsExpanded(false);
    } else {
      setIsExpanded(true);
      if (members.length === 0) {
        await loadMembers();
      }
    }
  };

  const handleTransferred = async () => {
    await refreshOrgs();
  };

  return (
    <>
      <button
        onClick={toggleExpanded}
        className="px-3 py-1.5 text-sm border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] flex items-center gap-1.5"
      >
        <RefreshCw className={cn("w-4 h-4", isExpanded && "animate-spin")} />
        Transfer Ownership
      </button>

      {isExpanded && (
        <div className="mt-4 p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
          <h3 className="text-sm font-semibold mb-3">Transfer Ownership</h3>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : members.length > 0 ? (
            <>
              <p className="text-sm text-[var(--text-secondary)] mb-3">
                Select a member to transfer ownership to. You will become an admin after the transfer.
              </p>
              <div className="space-y-2">
                {members.map((member) => (
                  <div
                    key={member.user_id}
                    className="flex items-center justify-between p-3 bg-[var(--bg-tertiary)] rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                        <span className="text-blue-600 font-medium text-sm">
                          {member.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-sm">{member.name}</p>
                        <p className="text-xs text-[var(--text-secondary)]">{member.email}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedMember(member)}
                      className="px-3 py-1.5 text-sm bg-yellow-100 text-yellow-700 rounded-lg hover:bg-yellow-200"
                    >
                      Transfer
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No other members to transfer to.</p>
          )}
        </div>
      )}

      {selectedMember && (
        <TransferOwnershipDialog
          org={org}
          member={selectedMember}
          onClose={() => setSelectedMember(null)}
          onTransferred={handleTransferred}
        />
      )}
    </>
  );
}

function ApiKeysSettings({ org }: { org: any }) {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const { hasPermission } = usePermissions();
  const [keys, setKeys] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadKeys = async () => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.listApiKeys(org.id);
      setKeys(data);
    } catch (e) {
      console.error("Failed to load API keys", e);
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate pattern: loading keys after org change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadKeys();
  }, [org?.id]);

  const handleCreate = async () => {
    if (!org || !newKeyName.trim() || selectedScopes.length === 0) return;
    setCreating(true);
    try {
      const result = await api.createApiKey(org.id, newKeyName, selectedScopes);
      setCreatedKey(result.raw_key);
      setNewKeyName("");
      setSelectedScopes([]);
      setShowCreate(false);
      await loadKeys();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create API key";
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    if (
      !org ||
      !(await confirm({
        title: "Revoke API key",
        description: "Are you sure you want to revoke this API key? This action cannot be undone.",
        confirmLabel: "Revoke",
        variant: "destructive",
      }))
    )
      return;
    try {
      await api.revokeApiKey(org.id, keyId);
      await loadKeys();
      toast.success("API key revoked");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to revoke API key";
      toast.error(message);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const allScopes = [
    { id: "references:read", label: "Read References" },
    { id: "references:write", label: "Write References" },
    { id: "jobs:read", label: "Read Jobs" },
    { id: "jobs:write", label: "Submit Jobs" },
  ];

  if (!org) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage API keys
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Create Form */}
      {(org?.role === "owner" || org?.role === "admin") && (
        <div className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
          {!showCreate && !createdKey && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:opacity-90"
            >
              <Plus className="w-4 h-4" />
              Create API Key
            </button>
          )}

          {showCreate && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Create New API Key</h3>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name (e.g., CI/CD Pipeline)"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)]"
              />
              <div>
                <p className="text-sm font-medium mb-2">Permissions</p>
                <div className="grid grid-cols-2 gap-2">
                  {allScopes.map((scope) => (
                    <label key={scope.id} className="flex items-center gap-2 p-2 border border-[var(--border-default)] rounded-lg cursor-pointer hover:bg-[var(--bg-tertiary)]">
                      <input
                        type="checkbox"
                        checked={selectedScopes.includes(scope.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedScopes([...selectedScopes, scope.id]);
                          } else {
                            setSelectedScopes(selectedScopes.filter((s) => s !== scope.id));
                          }
                        }}
                        className="rounded"
                      />
                      <span className="text-sm">{scope.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => { setShowCreate(false); setNewKeyName(""); setSelectedScopes([]); }}
                  className="px-4 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating || !newKeyName.trim() || selectedScopes.length === 0}
                  className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Create Key
                </button>
              </div>
            </div>
          )}

          {createdKey && (
            <div className="space-y-4">
              <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm font-medium text-green-800 mb-2">API Key Created</p>
                <p className="text-xs text-green-600 mb-3">
                  Copy this key now. You will not be able to see it again.
                </p>
                <div className="flex items-center gap-2 p-2 bg-white border border-green-200 rounded">
                  <code className="flex-1 text-sm font-mono break-all">{createdKey}</code>
                  <button
                    onClick={() => copyToClipboard(createdKey)}
                    className="p-1.5 hover:bg-green-100 rounded"
                    title="Copy to clipboard"
                  >
                    {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <button
                onClick={() => setCreatedKey(null)}
                className="text-sm text-blue-600 hover:underline"
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}

      {/* Keys List */}
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : keys.length === 0 ? (
        <div className="text-center py-12 text-[var(--text-secondary)]">
          <Key className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No API keys yet</p>
          <p className="text-sm">Create an API key for programmatic access</p>
        </div>
      ) : (
        <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] overflow-hidden">
          <table className="w-full">
            <thead className="bg-[var(--bg-tertiary)]">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Name</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Key</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Scopes</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Created</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Last Used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-t border-[var(--border-default)]">
                  <td className="px-4 py-3 font-medium">{key.name}</td>
                  <td className="px-4 py-3">
                    <code className="text-sm text-[var(--text-muted)] font-mono">...{key.key_prefix}</code>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((scope: string) => (
                        <span key={scope} className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">
                          {scope}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-muted)]">
                    {key.created_at ? new Date(key.created_at).toLocaleDateString() : "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-muted)]">
                    {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : "Never"}
                  </td>
                  <td className="px-4 py-3">
                    {(org?.role === "owner" || org?.role === "admin") && (
                      <button
                        onClick={() => handleRevoke(key.id)}
                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                        title="Revoke key"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}
