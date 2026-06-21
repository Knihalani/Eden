"use client";

/**
 * OrgTab — extracted from settings/page.tsx (June 2026 Phase 5).
 *
 * Org name / slug / role display + create / archive / delete /
 * transfer-ownership actions. Wraps the inlined patterns in the
 * new <SettingsCard> + <DangerZone> primitives.
 */

import { useState } from "react";
import { Archive, Building2, Copy, Loader2, Plus, RefreshCw } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/settings-card";
import { DangerZone } from "@/components/settings/danger-zone";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { DeleteOrgDialog } from "./delete-org-dialog";
import { TransferOwnershipDialog } from "./transfer-ownership-dialog";
import { DataExportPanel } from "./data-export-panel";

interface OrgTabProps {
  org: { id: string; name: string; slug: string; role: string } | null;
}

export function OrgTab({ org }: OrgTabProps) {
  const { refreshOrgs } = useOrg();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [name, setName] = useState(org?.name || "");

  // Transfer-ownership sub-state
  const [members, setMembers] = useState<
    Array<{ user_id: string; name: string; email: string; role: string }>
  >([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [isTransferExpanded, setIsTransferExpanded] = useState(false);
  const [selectedMember, setSelectedMember] = useState<{
    user_id: string;
    name: string;
    email: string;
    role: string;
  } | null>(null);

  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return;
    setLoading(true);
    try {
      await api.createOrg(newOrgName);
      setNewOrgName("");
      setShowCreate(false);
      await refreshOrgs();
    } catch {
      toast.error("Failed to create organization");
    } finally {
      setLoading(false);
    }
  };

  async function loadMembers() {
    if (!org) return;
    setLoadingMembers(true);
    try {
      const data = await api.listOrgMembers(org.id);
      setMembers(
        (data as Array<{ user_id: string; name: string; email: string; role: string }>).filter(
          (m) => m.role !== "owner"
        )
      );
    } finally {
      setLoadingMembers(false);
    }
  }

  async function toggleTransfer() {
    if (isTransferExpanded) {
      setIsTransferExpanded(false);
    } else {
      setIsTransferExpanded(true);
      if (members.length === 0) await loadMembers();
    }
  }

  if (!org && !showCreate) {
    return (
      <EmptyState
        icon={Building2}
        title="No organization yet"
        description="Create an organization to start managing members, keys, and settings."
        action={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4" />
            Create Organization
          </Button>
        }
      />
    );
  }

  if (showCreate) {
    return (
      <SettingsCard title="Create Organization">
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
            className="px-4 py-2 text-sm text-[var(--text-muted)]"
          >
            Cancel
          </button>
          <button
            onClick={handleCreateOrg}
            disabled={loading}
            className="px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create Organization"}
          </button>
        </div>
      </SettingsCard>
    );
  }

  if (!org) return null;

  const isAdmin = org.role === "owner" || org.role === "admin";
  const isOwner = org.role === "owner";

  return (
    <div className="space-y-4">
      <SettingsCard title="Organization details">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
              Slug
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={org.slug}
                disabled
                className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
              />
              <button
                onClick={() => navigator.clipboard.writeText(org.slug)}
                className="p-2 hover:bg-[var(--bg-tertiary)] rounded-lg text-[var(--text-muted)]"
                title="Copy slug"
                aria-label="Copy slug"
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
                  : org.role === "admin"
                  ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              )}
            >
              {org.role}
            </span>
          </div>
        </div>
      </SettingsCard>

      {isAdmin && (
        <SettingsCard title="Manage organization">
          <div className="flex flex-wrap items-center gap-3">
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
                  toast.error(err instanceof Error ? err.message : "Failed to archive organization");
                }
              }}
              className="px-3 py-1.5 text-sm border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] flex items-center gap-1.5 text-[var(--text-primary)]"
            >
              <Archive className="w-4 h-4" />
              Archive
            </button>
            <DataExportPanel orgId={org.id} canExport={true} />
          </div>
        </SettingsCard>
      )}

      {isOwner && (
        <DangerZone
          title="Permanent actions"
          description="Deleting or transferring an organization is irreversible. Make sure all admins have a backup plan."
        >
          <div className="space-y-3">
            <button
              onClick={toggleTransfer}
              className="px-3 py-1.5 text-sm border border-[var(--error)]/40 rounded-lg hover:bg-[var(--error-dim)] flex items-center gap-1.5 text-[var(--error)]"
            >
              <RefreshCw className={cn("w-4 h-4", isTransferExpanded && "animate-spin")} />
              Transfer Ownership
            </button>
            {isTransferExpanded && (
              <div className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-subtle)]">
                {loadingMembers ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
                  </div>
                ) : members.length > 0 ? (
                  <>
                    <p className="text-sm text-[var(--text-secondary)] mb-3">
                      Select a member to transfer ownership to. You will become an admin after the transfer.
                    </p>
                    <div className="space-y-2">
                      {members.map((m) => (
                        <div
                          key={m.user_id}
                          className="flex items-center justify-between p-3 bg-[var(--bg-tertiary)] rounded-lg"
                        >
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
                          <button
                            onClick={() => setSelectedMember(m)}
                            className="px-3 py-1.5 text-sm bg-[var(--warning-bg)] text-[var(--warning)] rounded-lg hover:opacity-90"
                          >
                            Transfer
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-[var(--text-muted)]">
                    No other members to transfer to.
                  </p>
                )}
              </div>
            )}

            <div className="pt-3 border-t border-[var(--error)]/20">
              <DeleteOrgDialog
                orgId={org.id}
                orgName={org.name}
                onDeleted={async () => {
                  await refreshOrgs();
                }}
              />
            </div>
          </div>
        </DangerZone>
      )}

      {selectedMember && org && (
        <TransferOwnershipDialog
          org={org}
          member={selectedMember}
          onClose={() => setSelectedMember(null)}
          onTransferred={async () => {
            await refreshOrgs();
          }}
        />
      )}

      {ConfirmDialog}
    </div>
  );
}
