"use client";

import { useState } from "react";
import { useOrganizationList } from "@clerk/nextjs";
import { Building2, Plus, Copy, Archive, Loader2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/settings-card";
import { EmptyState } from "@/components/ui/empty-state";
import type { Organization } from "@/lib/types";
import { DeleteOrgDialog } from "./delete-org-dialog";
import { TransferOwnershipSection } from "./transfer-ownership-section";
import { DataExportPanel } from "./data-export-panel";

interface OrgSettingsProps {
  org: Organization | null;
}

export function OrgSettings({ org }: OrgSettingsProps) {
  const { refreshOrgs, setCurrentOrg } = useOrg();
  const { role: resolvedRole } = usePermissions();
  const { setActive: setActiveOrg } = useOrganizationList();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(org?.name || "");
  const [showCreate, setShowCreate] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const isPersonal = Boolean(org?.is_personal);
  const isAdmin =
    isAdminOrOwner(resolvedRole) || isAdminOrOwner(org?.role);
  const isOwner =
    isOwnerRole(resolvedRole) ||
    isOwnerRole(org?.role) ||
    Boolean(org?.is_owner);

  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return;
    setLoading(true);
    try {
      const created = await api.createOrg(newOrgName);
      const clerkId = clerkOrgIdToActivate(created);
      if (clerkId && setActiveOrg) {
        await setActiveOrg({ organization: clerkId });
      }
      setNewOrgName("");
      setShowCreate(false);
      await refreshOrgs();
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

  if (!org && !showCreate) {
    return (
      <SettingsCard title="Organization">
        <EmptyState
          icon={Building2}
          title="No organization yet"
          description="Create an organization to start observing agents and inviting your team."
          size="md"
          action={
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              Create Organization
            </button>
          }
        />
      </SettingsCard>
    );
  }

  if (showCreate) {
    return (
      <SettingsCard title="Create Organization" description="Pick a name for your team.">
        <input
          type="text"
          value={newOrgName}
          onChange={(e) => setNewOrgName(e.target.value)}
          placeholder="Organization name"
          className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] mb-4 bg-[var(--bg-secondary)] text-[var(--text-primary)]"
        />
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => setShowCreate(false)}
            className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleCreateOrg}
            disabled={loading}
            className="px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create Organization"}
          </button>
        </div>
      </SettingsCard>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Organization Details"
        description="Your team's name, slug, and role. Slug is used in API URLs and can't be changed."
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Slug</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={org?.slug || ""}
                disabled
                className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              />
              <button
                onClick={() => navigator.clipboard.writeText(org?.slug || "")}
                className="p-2 hover:bg-[var(--bg-tertiary)] rounded-lg text-[var(--text-secondary)]"
                title="Copy slug"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="pt-2">
            <span className="text-sm font-medium text-[var(--text-secondary)]">Role: </span>
            <span
              className={cn(
                "px-2 py-1 rounded-md text-sm font-medium",
                isOwner
                  ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                  : org?.role === "admin"
                    ? "bg-[var(--accent-bg)] text-[var(--accent)]"
                    : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
              )}
            >
              {org?.role}
            </span>
          </div>

          {isAdmin && (
            <div className="pt-4 border-t border-[var(--border-default)] flex flex-wrap items-center gap-3">
              <button
                onClick={async () => {
                  if (!org) return;
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
                className="px-3 py-1.5 text-sm border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] inline-flex items-center gap-1.5 text-[var(--text-primary)]"
              >
                <Archive className="w-4 h-4" />
                Archive
              </button>
              {isOwner && (
                <>
                  <DeleteOrgDialog
                    orgId={org!.id}
                    orgName={org!.name}
                    onDeleted={async () => {
                      await refreshOrgs();
                    }}
                  />
                  {!isPersonal && <TransferOwnershipSection org={org!} />}
                </>
              )}
              <DataExportPanel orgId={org!.id} canExport={true} />
            </div>
          )}
        </div>
      </SettingsCard>
      {ConfirmDialog}
    </div>
  );
}
