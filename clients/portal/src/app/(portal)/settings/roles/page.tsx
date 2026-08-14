"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader, Panel, StatusChip } from "@/components/ds/primitives";
import {
  InlineLoading,
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { EmptyState } from "@/lab/lab-ui";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useLabToast } from "@/lab/lab-toast";
import { SettingsModeNav } from "@/lab/settings/settings-chrome";
import { formatSmartTime } from "@/lib/format";
import { api } from "@/lib/api/resources";
import { queryKeys } from "@/lib/query-keys";

const BASE_ROLES = ["owner", "admin", "member", "viewer"] as const;

export default function SettingsRolesPage() {
  const router = useRouter();
  const { currentOrg, organizations, orgSyncing } = useOrg();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission("settings:edit");
  const { pushToast } = useLabToast();
  const orgId = currentOrg?.id ?? null;

  const rolesQuery = useOrgQuery(queryKeys.portal.roles(orgId), orgId, () =>
    api.listRoles(orgId!),
  );
  const permissionsQuery = useOrgQuery(
    queryKeys.portal.permissionsCatalogue(orgId),
    orgId,
    () => api.listPermissions(orgId!),
  );
  const membersQuery = useOrgQuery(queryKeys.portal.members(orgId), orgId, () =>
    api.listOrgMembers(orgId!),
  );

  const roles = rolesQuery.data ?? [];
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedRoleId && roles.length > 0) setSelectedRoleId(roles[0].id);
  }, [roles, selectedRoleId]);
  const selectedRole = roles.find((r) => r.id === selectedRoleId) ?? null;

  const assignmentsQuery = useOrgQuery(
    queryKeys.portal.roleAssignments(orgId, selectedRoleId),
    orgId,
    () => api.listRoleAssignments(orgId!, selectedRoleId!),
    { enabled: Boolean(selectedRoleId) },
  );

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBaseRole, setNewBaseRole] = useState<string>("member");
  const [newDescription, setNewDescription] = useState("");
  const [newPermissions, setNewPermissions] = useState<Set<string>>(new Set());

  const [editPermissions, setEditPermissions] = useState<Set<string>>(new Set());
  const [editDescription, setEditDescription] = useState("");
  const [editDirty, setEditDirty] = useState(false);

  useEffect(() => {
    if (!selectedRole) return;
    setEditPermissions(new Set(selectedRole.permissions));
    setEditDescription(selectedRole.description ?? "");
    setEditDirty(false);
  }, [selectedRole]);

  const createMutation = useOrgMutation(
    () =>
      api.createRole(orgId!, {
        name: newName.trim(),
        base_role: newBaseRole as "owner" | "admin" | "member" | "viewer",
        description: newDescription.trim() || undefined,
        permissions: Array.from(newPermissions),
      }),
    {
      invalidateKeys: [queryKeys.portal.roles(orgId)],
      onSuccess: (role) => {
        pushToast({ title: `Role "${role.name}" created`, tone: "ok" });
        setCreating(false);
        setNewName("");
        setNewDescription("");
        setNewPermissions(new Set());
        setSelectedRoleId(role.id);
      },
      onError: (err) => pushToast({ title: "Create role failed", body: err.message, tone: "fail" }),
    },
  );

  const updateMutation = useOrgMutation(
    () =>
      api.updateRole(orgId!, selectedRoleId!, {
        description: editDescription.trim() || null,
        permissions: Array.from(editPermissions),
      }),
    {
      invalidateKeys: [queryKeys.portal.roles(orgId)],
      onSuccess: () => {
        pushToast({ title: "Role updated", tone: "ok" });
        setEditDirty(false);
      },
      onError: (err) => pushToast({ title: "Update failed", body: err.message, tone: "fail" }),
    },
  );

  const deleteMutation = useOrgMutation(
    (roleId: string) => api.deleteRole(orgId!, roleId),
    {
      invalidateKeys: [queryKeys.portal.roles(orgId)],
      onSuccess: () => {
        pushToast({ title: "Role deleted", tone: "ok" });
        setSelectedRoleId(null);
      },
      onError: (err) => pushToast({ title: "Delete failed", body: err.message, tone: "fail" }),
    },
  );

  const [assignUserId, setAssignUserId] = useState("");
  const [assignResourceType, setAssignResourceType] = useState("");
  const [assignResourceId, setAssignResourceId] = useState("");

  const assignMutation = useOrgMutation(
    () =>
      api.createRoleAssignment(orgId!, selectedRoleId!, {
        user_id: assignUserId,
        resource_type: assignResourceType.trim() || null,
        resource_id: assignResourceId.trim() || null,
      }),
    {
      invalidateKeys: [queryKeys.portal.roleAssignments(orgId, selectedRoleId)],
      onSuccess: () => {
        pushToast({ title: "Role assigned", tone: "ok" });
        setAssignUserId("");
        setAssignResourceType("");
        setAssignResourceId("");
      },
      onError: (err) => pushToast({ title: "Assign failed", body: err.message, tone: "fail" }),
    },
  );

  const unassignMutation = useOrgMutation(
    (assignmentId: string) => api.deleteRoleAssignment(orgId!, selectedRoleId!, assignmentId),
    {
      invalidateKeys: [queryKeys.portal.roleAssignments(orgId, selectedRoleId)],
      onSuccess: () => pushToast({ title: "Assignment removed", tone: "ok" }),
      onError: (err) => pushToast({ title: "Remove failed", body: err.message, tone: "fail" }),
    },
  );

  const permByResource = useMemo(() => {
    const perms = permissionsQuery.data?.permissions ?? [];
    const grouped = new Map<string, typeof perms>();
    for (const p of perms) {
      const list = grouped.get(p.resource) ?? [];
      list.push(p);
      grouped.set(p.resource, list);
    }
    return grouped;
  }, [permissionsQuery.data]);

  const memberEmailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) map.set(m.user_id, m.email);
    return map;
  }, [membersQuery.data]);

  function togglePerm(set: Set<string>, setter: (s: Set<string>) => void, key: string) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  }

  const nav = (
    <SettingsModeNav
      value="roles"
      onChange={(next) => router.push(`/settings?mode=${next}`)}
    />
  );

  if (!orgSyncing && !currentOrg) {
    return (
      <NoWorkspaceGuard
        title="Roles"
        message={
          organizations.length === 0
            ? "No workspace yet — create one from the banner above to get started."
            : "Select a workspace to view roles."
        }
        actions={nav}
      />
    );
  }

  if (rolesQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Roles" actions={nav} />
        <QueryLoadingPanel label="Loading roles…" />
      </div>
    );
  }

  if (rolesQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Roles" actions={nav} />
        <QueryErrorPanel error={rolesQuery.error} onRetry={() => rolesQuery.refetch()} />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Roles"
        meta="Custom roles and built-in access"
        actions={
          <div className="flex items-center gap-2">
            {nav}
            {canEdit && (
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                onClick={() => setCreating((v) => !v)}
              >
                + New role
              </button>
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        {creating && (
          <Panel>
            <div className="flex flex-col gap-3 p-4 sm:p-5">
              <h2 className="type-ui text-[var(--text)]">New role</h2>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  className="ds-input flex-1"
                  placeholder="Role name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <select
                  className="ds-input"
                  value={newBaseRole}
                  onChange={(e) => setNewBaseRole(e.target.value)}
                >
                  {BASE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      base: {r}
                    </option>
                  ))}
                </select>
              </div>
              <input
                className="ds-input"
                placeholder="Description (optional)"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
              <PermissionPicker
                grouped={permByResource}
                selected={newPermissions}
                onToggle={(key) => togglePerm(newPermissions, setNewPermissions, key)}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="ds-btn ds-btn-primary ds-btn-sm"
                  disabled={!newName.trim() || createMutation.isPending}
                  onClick={() => createMutation.mutate()}
                >
                  {createMutation.isPending ? "Creating…" : "Create role"}
                </button>
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Panel>
        )}

        <Panel>
          <div className="p-4 sm:p-5">
            <h2 className="type-ui text-[var(--text)]">Built-in roles</h2>
            <ul className="mt-3 space-y-2" aria-label="Built-in roles">
              {(
                [
                  ["Owner", "Full workspace control, including billing and deletion."],
                  ["Admin", "Manage members, keys, and settings. Cannot delete the workspace."],
                  ["Member", "Use traces, evals, and improve. Cannot change billing."],
                  ["Viewer", "Read-only access to traces, issues, and settings."],
                ] as const
              ).map(([name, summary]) => (
                <li key={name} className="border-b border-[var(--line)] pb-2 last:border-b-0 last:pb-0">
                  <p className="type-ui text-[var(--text)]">{name}</p>
                  <p className="type-meta mt-0.5">{summary}</p>
                </li>
              ))}
            </ul>
          </div>
        </Panel>

        {roles.length === 0 && !creating ? (
          <EmptyState
            title="No custom roles yet"
            body="Create a role to grant a scoped permission set beyond the built-in roles above."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]">
            <Panel className="!p-0">
              <ul>
                {roles.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedRoleId(r.id)}
                      className={
                        "flex w-full flex-col items-start gap-1 border-b border-[var(--line)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)]" +
                        (selectedRoleId === r.id ? " bg-[var(--accent-muted)]" : "")
                      }
                    >
                      <span className="type-ui text-[var(--text)]">{r.name}</span>
                      <span className="type-meta text-[var(--text-faint)]">
                        base: {r.base_role} · {r.permissions.length} permission
                        {r.permissions.length === 1 ? "" : "s"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel>
              {!selectedRole ? (
                <div className="p-5">
                  <p className="type-meta text-[var(--text-faint)]">Select a role.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-4 p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="type-ui text-[var(--text)]">{selectedRole.name}</h2>
                      <p className="type-meta text-[var(--text-faint)]">
                        base: {selectedRole.base_role} · created{" "}
                        {formatSmartTime(selectedRole.created_at)}
                      </p>
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        className="ds-btn ds-btn-ghost ds-btn-sm"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete role "${selectedRole.name}"?`)) {
                            deleteMutation.mutate(selectedRole.id);
                          }
                        }}
                      >
                        Delete role
                      </button>
                    )}
                  </div>

                  <div>
                    <label className="type-ui mb-1 block text-[var(--text)]">Description</label>
                    <input
                      className="ds-input w-full"
                      value={editDescription}
                      disabled={!canEdit}
                      onChange={(e) => {
                        setEditDescription(e.target.value);
                        setEditDirty(true);
                      }}
                    />
                  </div>

                  <div>
                    <h3 className="type-ui mb-2 text-[var(--text)]">
                      Permissions ({editPermissions.size})
                    </h3>
                    <PermissionPicker
                      grouped={permByResource}
                      selected={editPermissions}
                      disabled={!canEdit}
                      onToggle={(key) => {
                        togglePerm(editPermissions, setEditPermissions, key);
                        setEditDirty(true);
                      }}
                    />
                  </div>

                  {canEdit && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="ds-btn ds-btn-primary ds-btn-sm"
                        disabled={!editDirty || updateMutation.isPending}
                        onClick={() => updateMutation.mutate()}
                      >
                        {updateMutation.isPending ? "Saving…" : "Save changes"}
                      </button>
                      {editDirty && (
                        <span className="type-meta text-[var(--text-faint)]">Unsaved changes</span>
                      )}
                    </div>
                  )}

                  <div className="border-t border-[var(--line)] pt-4">
                    <h3 className="type-ui mb-2 text-[var(--text)]">Assigned members</h3>
                    {assignmentsQuery.isLoading ? (
                      <div
                        className="space-y-1.5"
                        role="status"
                        aria-label="Loading assigned members"
                      >
                        <div className="eden-skeleton-pulse h-3.5 w-2/5 rounded bg-[var(--line)]" />
                        <div className="eden-skeleton-pulse h-3.5 w-1/3 rounded bg-[var(--line)]" />
                      </div>
                    ) : (assignmentsQuery.data ?? []).length === 0 ? (
                      <p className="type-meta text-[var(--text-faint)]">
                        No members assigned to this role yet.
                      </p>
                    ) : (
                      <ul className="mb-3 flex flex-col gap-1.5">
                        {(assignmentsQuery.data ?? []).map((a) => (
                          <li
                            key={a.id}
                            className="flex items-center justify-between gap-2 rounded-md border border-[var(--line)] px-3 py-1.5"
                          >
                            <span className="type-meta text-[var(--text)]">
                              {memberEmailByUserId.get(a.user_id) ?? a.user_id}
                              {a.resource_type && (
                                <span className="ml-2 text-[var(--text-faint)]">
                                  scope: {a.resource_type}:{a.resource_id}
                                </span>
                              )}
                            </span>
                            {canEdit && (
                              <button
                                type="button"
                                className="ds-btn ds-btn-ghost ds-btn-sm"
                                disabled={unassignMutation.isPending}
                                onClick={() => unassignMutation.mutate(a.id)}
                              >
                                Remove
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    {canEdit && (
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <select
                          className="ds-input flex-1"
                          value={assignUserId}
                          onChange={(e) => setAssignUserId(e.target.value)}
                        >
                          <option value="">Select a member…</option>
                          {(membersQuery.data ?? []).map((m) => (
                            <option key={m.user_id} value={m.user_id}>
                              {m.email}
                            </option>
                          ))}
                        </select>
                        <input
                          className="ds-input w-32"
                          placeholder="resource_type"
                          value={assignResourceType}
                          onChange={(e) => setAssignResourceType(e.target.value)}
                        />
                        <input
                          className="ds-input w-32"
                          placeholder="resource_id"
                          value={assignResourceId}
                          onChange={(e) => setAssignResourceId(e.target.value)}
                        />
                        <button
                          type="button"
                          className="ds-btn ds-btn-primary ds-btn-sm"
                          disabled={!assignUserId || assignMutation.isPending}
                          onClick={() => assignMutation.mutate()}
                        >
                          Assign
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

function PermissionPicker({
  grouped,
  selected,
  onToggle,
  disabled,
}: {
  grouped: Map<string, Array<{ key: string; resource: string; action: string; granted_by_default: string[] }>>;
  selected: Set<string>;
  onToggle: (key: string) => void;
  disabled?: boolean;
}) {
  if (grouped.size === 0) {
    return <InlineLoading label="Loading permission catalogue" />;
  }
  return (
    <div className="flex max-h-64 flex-col gap-3 overflow-y-auto rounded-md border border-[var(--line)] p-3">
      {Array.from(grouped.entries()).map(([resource, perms]) => (
        <div key={resource}>
          <p className="type-meta mb-1 font-medium text-[var(--text-secondary)]">{resource}</p>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {perms.map((p) => (
              <label key={p.key} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={selected.has(p.key)}
                  disabled={disabled}
                  onChange={() => onToggle(p.key)}
                />
                <span className="type-meta text-[var(--text)]">{p.action}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
