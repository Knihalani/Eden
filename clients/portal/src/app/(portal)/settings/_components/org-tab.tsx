"use client";

/**
 * OrgTab — Workspace identity leaf (Wave 3).
 *
 * Name / slug edit, create, archive / delete / transfer. Kit
 * SettingsCard + DangerZone + Button / Dialog only.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import { Archive, Building2, Copy, Plus } from "lucide-react";
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
import { SettingsCard } from "@/components/settings/settings-card";
import { DangerZone } from "@/components/settings/danger-zone";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DeleteOrgDialog } from "./delete-org-dialog";
import { TransferOwnershipSection } from "./transfer-ownership-section";
import { DataExportPanel } from "./data-export-panel";
import type { Organization } from "@/lib/types";
import {
  dangerZoneDescription,
  normalizeSlug,
  roleBadgeClass,
} from "./org-tab-helpers";

export const WS3_ORG_COMPLETED = true as const;

interface OrgTabProps {
  org: Organization | null;
}

export function OrgTab({ org }: OrgTabProps) {
  const { refreshOrgs, setCurrentOrg } = useOrg();
  const { role: resolvedRole } = usePermissions();
  const { organization: clerkOrg } = useOrganization();
  const { setActive: setActiveOrg } = useOrganizationList();
  const searchParams = useSearchParams();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();

  const [loading, setLoading] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [name, setName] = useState(org?.name ?? "");
  const [slug, setSlug] = useState(org?.slug ?? "");
  const isPersonal = Boolean(org?.is_personal);

  useEffect(() => {
    setName(org?.name ?? "");
    setSlug(org?.slug ?? "");
  }, [org?.id, org?.name, org?.slug]);

  // Overview / Members CTAs deep-link here with ?create=1 (or intent=create-team).
  useEffect(() => {
    const create =
      searchParams.get("create") === "1" ||
      searchParams.get("intent") === "create-team";
    if (create) setShowCreate(true);
  }, [searchParams]);
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
        toast.success("Workspace created");
      }
    } catch {
      toast.error("Failed to create workspace");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveIdentity = async () => {
    if (!org) return;
    const nextName = name.trim();
    const nextSlug = normalizeSlug(slug);
    if (!nextName || !nextSlug) {
      toast.error("Name and slug are required");
      return;
    }
    if (!clerkOrg) {
      toast.error("Rename unavailable until workspace sync completes");
      return;
    }
    setSavingIdentity(true);
    try {
      await clerkOrg.update({ name: nextName, slug: nextSlug });
      setCurrentOrg({ ...org, name: nextName, slug: nextSlug });
      await refreshOrgs();
      toast.success("Workspace updated");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update workspace");
    } finally {
      setSavingIdentity(false);
    }
  };

  const handleArchive = async () => {
    if (!org) return;
    if (
      !(await confirm({
        title: "Archive workspace",
        description: `Archive ${org.name}? It will be hidden from the workspace switcher.`,
        confirmLabel: "Archive",
        variant: "destructive",
      }))
    ) {
      return;
    }
    try {
      await api.archiveOrg(org.id);
      await refreshOrgs();
      toast.success("Workspace archived");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to archive workspace");
    }
  };

  if (!org && !showCreate) {
    return (
      <div data-ws3-org="true">
        <EmptyState
          icon={Building2}
          title="No workspace yet"
          description="No workspace yet. Create one to manage members, API keys, and settings. The product tour does not create or sync your workspace."
          action={
            <Button className="min-h-11" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" />
              Create workspace
            </Button>
          }
        />
      </div>
    );
  }

  if (showCreate) {
    return (
      <div data-ws3-org="true" data-ws3-org-create="true">
        <SettingsCard
          title={isPersonal ? "Create a team workspace" : "Create workspace"}
          description={
            isPersonal
              ? "Your personal workspace stays; this creates a separate team workspace you can switch to."
              : "Pick a name for your team."
          }
        >
          <FormField label="Workspace name" htmlFor="create-org-name">
            <Input
              id="create-org-name"
              type="text"
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
              placeholder="Workspace name"
            />
          </FormField>
          <div className="mt-space-4 flex gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleCreateOrg()} loading={loading}>
              {isPersonal ? "Create team workspace" : "Create workspace"}
            </Button>
          </div>
        </SettingsCard>
      </div>
    );
  }

  if (!org) return null;

  const isAdmin = isAdminOrOwner(resolvedRole) || isAdminOrOwner(org.role);
  const isOwner =
    isOwnerRole(resolvedRole) || isOwnerRole(org.role) || Boolean(org.is_owner);
  const identityDirty =
    name.trim() !== org.name || normalizeSlug(slug) !== org.slug;

  return (
    <div className="space-y-space-4" data-ws3-org="true">
      {isPersonal ? (
        <SettingsCard
          title="Upgrade to a team workspace"
          description="Invites, SCIM, and ownership transfer need a team workspace."
        >
          <Button
            type="button"
            className="min-h-11"
            onClick={() => setShowCreate(true)}
            data-ws3-create-team
          >
            <Plus className="w-4 h-4" />
            Create a team workspace
          </Button>
        </SettingsCard>
      ) : null}

      <SettingsCard
        title="Workspace details"
        description="Name and slug used across the portal and API URLs."
      >
        <div className="space-y-space-4">
          <FormField
            label="Name"
            htmlFor="org-name"
            description={
              isAdmin
                ? "Visible name for this workspace."
                : "Only workspace admins can rename."
            }
          >
            <Input
              id="org-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              readOnly={!isAdmin}
              aria-readonly={!isAdmin ? true : undefined}
              disabled={!isAdmin}
            />
          </FormField>
          <FormField
            label="Slug"
            htmlFor="org-slug"
            description="Lowercase URL identifier. Changing it may break existing API URLs."
          >
            <div className="flex items-center gap-space-2">
              <Input
                id="org-slug"
                type="text"
                value={slug}
                onChange={(e) => setSlug(normalizeSlug(e.target.value))}
                readOnly={!isAdmin}
                disabled={!isAdmin}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => {
                  void navigator.clipboard.writeText(org.slug);
                  toast.success("Slug copied");
                }}
                aria-label="Copy slug"
                title="Copy slug"
              >
                <Copy className="w-4 h-4" />
              </Button>
            </div>
          </FormField>
          {isAdmin ? (
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => void handleSaveIdentity()}
                loading={savingIdentity}
                disabled={!identityDirty || savingIdentity}
              >
                Save changes
              </Button>
            </div>
          ) : null}
          <div className="pt-space-2">
            <span className="text-sm font-medium text-[var(--text-secondary)]">Role: </span>
            <span className={roleBadgeClass(org.role, isOwner)}>{org.role}</span>
          </div>
        </div>
      </SettingsCard>

      {isAdmin ? (
        <SettingsCard title="Manage workspace">
          <div className="flex flex-wrap items-center gap-space-3">
            <DataExportPanel orgId={org.id} canExport={true} />
          </div>
        </SettingsCard>
      ) : null}

      {isAdmin ? (
        <DangerZone title="Permanent actions" description={dangerZoneDescription(isPersonal)}>
          <div className="space-y-space-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleArchive()}
              className="border-[var(--error)] text-[var(--error)] hover:bg-[var(--error-dim)]"
            >
              <Archive className="w-4 h-4" />
              Archive
            </Button>

            {!isPersonal && isOwner ? <TransferOwnershipSection org={org} /> : null}

            {isOwner ? (
              <div className="pt-space-3 border-t border-[var(--error)]/20">
                <DeleteOrgDialog
                  orgId={org.id}
                  orgName={org.name}
                  onDeleted={async () => {
                    await refreshOrgs();
                  }}
                />
              </div>
            ) : null}
          </div>
        </DangerZone>
      ) : null}

      {ConfirmDialog}
    </div>
  );
}
