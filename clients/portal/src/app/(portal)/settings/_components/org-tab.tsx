"use client";

/**
 * OrgTab — extracted from settings/page.tsx (June 2026 Phase 5).
 *
 * Org name / slug / role display + create / archive / delete /
 * transfer-ownership actions. Wraps the inlined patterns in the
 * new <SettingsCard> + <DangerZone> primitives.
 */
import { useMemo, useState } from "react";
import { useOrganizationList } from "@clerk/nextjs";
import { Archive, Building2, Copy, Loader2, Plus, RefreshCw } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import {
  CREATE_ORG_DEGRADED_DESCRIPTION,
  CREATE_ORG_DEGRADED_TITLE,
  clerkOrgIdToActivate,
  isCreateOrgDegraded,
  organizationFromCreate,
} from "@/lib/create-org";
import { isAdminOrOwner, isOwnerRole } from "@/lib/roles";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/settings-card";
import { DangerZone } from "@/components/settings/danger-zone";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { DeleteOrgDialog } from "./delete-org-dialog";
import { TransferOwnershipDialog } from "./transfer-ownership-dialog";
import { DataExportPanel } from "./data-export-panel";
import { Card } from "@/components/ui/card";
import type { Organization } from "@/lib/types";
import { errorFromCaught } from "@/lib/safe-error-message";

interface OrgTabProps {
  org: Organization | null;
}
export function OrgTab({
  org
}: OrgTabProps) {
  const {
    refreshOrgs,
    setCurrentOrg,
  } = useOrg();
  const { role: resolvedRole } = usePermissions();
  const { setActive: setActiveOrg } = useOrganizationList();
  const toast = useToast();
  const {
    confirm,
    ConfirmDialog
  } = useConfirm();
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const orgId = org?.id ?? null;
  const isPersonal = Boolean(org?.is_personal);

  // Transfer-ownership sub-state
  const [isTransferExpanded, setIsTransferExpanded] = useState(false);
  const [selectedMember, setSelectedMember] = useState<{
    user_id: string;
    name: string;
    email: string;
    role: string;
  } | null>(null);
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
        }>
      >,
    { enabled: isTransferExpanded },
  );
  const members = useMemo(
    () => (membersQuery.data ?? []).filter(m => m.role !== "owner"),
    [membersQuery.data],
  );
  const loadingMembers = membersQuery.isLoading;
  const membersError = membersQuery.error
    ? errorFromCaught(membersQuery.error, "Could not load members")
    : null;
  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return;
    setLoading(true);
    try {
      const created = await api.createOrg(newOrgName);
      // Activate the new Clerk org so the proxy forwards X-Org-Id and
      // JWT claims include org:admin — otherwise API-key / admin routes
      // see no session org and treat the creator as a non-admin.
      const clerkId = clerkOrgIdToActivate(created);
      if (clerkId && setActiveOrg) {
        await setActiveOrg({ organization: clerkId });
      }
      setNewOrgName("");
      setShowCreate(false);
      await refreshOrgs();
      // Always select the Eden org we just created. When clerk_org_id is
      // null, setActive was skipped and applyMeToOrgState may keep the
      // previous Clerk-active org — leaving the creator without owner UX.
      setCurrentOrg(organizationFromCreate(created));
      if (isCreateOrgDegraded(created)) {
        toast.warning(CREATE_ORG_DEGRADED_TITLE, CREATE_ORG_DEGRADED_DESCRIPTION);
      } else {
        toast.success("Organization created");
      }
    } catch {
      toast.error("Failed to create organization");
    } finally {
      setLoading(false);
    }
  };
  function toggleTransfer() {
    setIsTransferExpanded(prev => !prev);
  }
  if (!org && !showCreate) {
    return (
      <EmptyState
        icon={Building2}
        title="No organization yet"
        description="Create an organization here to manage members, API keys, and settings. The product tour does not create or sync your workspace."
        action={
          <Button className="min-h-11" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4" />
            Create Organization
          </Button>
        }
      />
    );
  }
  if (showCreate) {
    return <SettingsCard title="Create Organization">
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1" htmlFor="create-org-name">
          Organization name
        </label>
        <input id="create-org-name" type="text" value={newOrgName} onChange={e => setNewOrgName(e.target.value)} placeholder="Organization name" className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] mb-4 bg-[var(--bg-secondary)] text-[var(--text-primary)]" />
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={() => setShowCreate(false)} className="min-h-11 px-4 py-2 text-sm text-[var(--text-muted)]">
            Cancel
          </button>
          <button type="button" onClick={handleCreateOrg} disabled={loading} className="min-h-11 px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create Organization"}
          </button>
        </div>
      </SettingsCard>;
  }
  if (!org) return null;
  // Prefer W2-D resolveRole so creators keep admin/owner during Clerk sync lag.
  const isAdmin =
    isAdminOrOwner(resolvedRole) || isAdminOrOwner(org.role);
  const isOwner =
    isOwnerRole(resolvedRole) ||
    isOwnerRole(org.role) ||
    Boolean(org.is_owner);
  return <div className="space-y-4">
      <SettingsCard title="Organization details">
        <div className="space-y-4">
          <div>
            <label htmlFor="org-name" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
              Name
            </label>
            <input
              id="org-name"
              type="text"
              value={org.name}
              readOnly
              aria-readonly="true"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] cursor-default"
            />
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Rename not available in portal yet
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
              Slug
            </label>
            <div className="flex items-center gap-2">
              <input type="text" value={org.slug} disabled className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]" />
              <button onClick={() => navigator.clipboard.writeText(org.slug)} className="p-2 hover:bg-[var(--bg-tertiary)] rounded-lg text-[var(--text-muted)]" title="Copy slug" aria-label="Copy slug">
                <Copy className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="pt-2">
            <span className="text-sm font-medium text-[var(--text-secondary)]">Role: </span>
            <span className={cn("px-2 py-1 rounded-md text-sm font-medium", isOwner ? "bg-[var(--warning-bg)] text-[var(--warning)]" : org.role === "admin" ? "bg-[var(--accent-faint)] text-[var(--accent)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]")}>
              {org.role}
            </span>
          </div>
        </div>
      </SettingsCard>

      {isAdmin && <SettingsCard title="Manage organization">
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={async () => {
          if (!(await confirm({
            title: "Archive organization",
            description: `Archive ${org.name}? It will be hidden from the org switcher.`,
            confirmLabel: "Archive",
            variant: "destructive"
          }))) return;
          try {
            await api.archiveOrg(org.id);
            await refreshOrgs();
            toast.success("Organization archived");
          } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to archive organization");
          }
        }} className="px-3 py-1.5 text-sm border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] flex items-center gap-1.5 text-[var(--text-primary)]">
              <Archive className="w-4 h-4" />
              Archive
            </button>
            <DataExportPanel orgId={org.id} canExport={true} />
          </div>
        </SettingsCard>}

      {isOwner && <DangerZone title="Permanent actions" description={isPersonal ? "Deleting a personal workspace is irreversible." : "Deleting or transferring an organization is irreversible. Make sure all admins have a backup plan."}>
          <div className="space-y-3">
            {!isPersonal && <>
            <button onClick={toggleTransfer} className="px-3 py-1.5 text-sm border border-[var(--error)]/40 rounded-lg hover:bg-[var(--error-dim)] flex items-center gap-1.5 text-[var(--error)]">
              <RefreshCw className={cn("w-4 h-4", isTransferExpanded && "animate-spin")} />
              Transfer Ownership
            </button>
            {isTransferExpanded && <Card padding="md">
                {loadingMembers ? <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
                  </div> : membersError ? (
                  <ErrorState
                    title="Could not load members"
                    message={membersError}
                    size="sm"
                    action={
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        onClick={() => void membersQuery.refetch()}
                      >
                        <RefreshCw className="h-4 w-4" />
                        Try again
                      </Button>
                    }
                  />
                ) : members.length > 0 ? <>
                    <p className="text-sm text-[var(--text-secondary)] mb-3">
                      Select a member to transfer ownership to. You will become an admin after the transfer.
                    </p>
                    <div className="space-y-2">
                      {members.map(m => <div key={m.user_id} className="flex items-center justify-between p-3 bg-[var(--bg-tertiary)] rounded-lg">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-[var(--accent-faint)] rounded-full flex items-center justify-center">
                              <span className="text-[var(--accent)] font-medium text-sm">
                                {m.name.charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <div>
                              <p className="font-medium text-sm text-[var(--text-primary)]">
                                {m.name}
                              </p>
                              <p className="text-xs text-[var(--text-secondary)]">{m.email}</p>
                            </div>
                          </div>
                          <button onClick={() => setSelectedMember(m)} className="px-3 py-1.5 text-sm bg-[var(--warning-bg)] text-[var(--warning)] rounded-lg hover:opacity-90">
                            Transfer
                          </button>
                        </div>)}
                    </div>
                  </> : <p className="text-sm text-[var(--text-muted)]">
                    No other members to transfer to.
                  </p>}
              </Card>}
            </>}

            <div className={cn(!isPersonal && "pt-3 border-t border-[var(--error)]/20")}>
              <DeleteOrgDialog orgId={org.id} orgName={org.name} onDeleted={async () => {
            await refreshOrgs();
          }} />
            </div>
          </div>
        </DangerZone>}

      {!isPersonal && selectedMember && org && <TransferOwnershipDialog org={org} member={selectedMember} onClose={() => setSelectedMember(null)} onTransferred={async () => {
      await refreshOrgs();
    }} />}

      {ConfirmDialog}
    </div>;
}