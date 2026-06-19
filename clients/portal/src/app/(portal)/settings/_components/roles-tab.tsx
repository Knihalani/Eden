"use client";

/**
 * §6.3 — Custom roles management tab.
 *
 * Lets an org admin create, edit, and delete custom roles. Custom
 * roles inherit from a built-in base role (owner / admin / member
 * / viewer) and add an arbitrary permission set. Assignments are
 * the per-user (and optional per-resource) role grants.
 *
 * Renders inside the settings page tab list. The parent (page.tsx)
 * is responsible for routing and auth; this component just talks
 * to the /orgs/{org_id}/roles endpoints.
 */

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/hooks/use-confirm";
import {
  Loader2,
  Plus,
  Trash2,
  X,
  Shield,
  UserPlus,
  Check,
  Info,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

// Built-in permission keys. The full set lives in
// `src/eden/api/deps.py:PERMISSION_MAP`. We mirror a subset here
// for the form. New permissions added to PERMISSION_MAP need to
// be added here too.
const PERMISSION_PRESETS: { category: string; permissions: string[] }[] = [
  {
    category: "Members",
    permissions: ["members:invite", "members:remove"],
  },
  {
    category: "Jobs",
    permissions: ["jobs:read", "jobs:write"],
  },
  {
    category: "Settings",
    permissions: ["settings:edit"],
  },
  {
    category: "Billing",
    permissions: ["billing:view", "billing:edit"],
  },
  {
    category: "Audit",
    permissions: ["audit:view"],
  },
  {
    category: "Org",
    permissions: ["org:transfer"],
  },
];

const BASE_ROLES = ["owner", "admin", "member", "viewer"] as const;

interface Role {
  id: string;
  org_id: string;
  name: string;
  base_role: string;
  description: string | null;
  permissions: string[];
  created_at: string;
}

interface Assignment {
  id: string;
  role_id: string;
  user_id: string;
  resource_type: string | null;
  resource_id: string | null;
  granted_by: string | null;
  created_at: string;
}

export default function RolesTab() {
  const { currentOrg } = useOrg();
  const { confirm, ConfirmDialog } = useConfirm();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Record<string, Assignment[]>>({});

  const loadRoles = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Role[]>(`/orgs/${currentOrg.id}/roles`);
      setRoles(data);
    } catch (e) {
      setError(
        "Could not load roles. The RBAC migration (020) may not be applied yet, or your org does not have admin permissions.",
      );
      setRoles([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  async function loadAssignments(roleId: string) {
    if (!currentOrg) return;
    try {
      const data = await api.get<Assignment[]>(
        `/orgs/${currentOrg.id}/roles/${roleId}/assignments`,
      );
      setAssignments((prev) => ({ ...prev, [roleId]: data }));
    } catch {
      setAssignments((prev) => ({ ...prev, [roleId]: [] }));
    }
  }

  async function handleCreate(form: {
    name: string;
    base_role: string;
    description: string;
    permissions: string[];
  }) {
    if (!currentOrg) return;
    try {
      await api.post(`/orgs/${currentOrg.id}/roles`, form);
      setShowCreate(false);
      loadRoles();
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not create role: ${e.message}`
          : "Could not create role.",
      );
    }
  }

  async function handleDelete(role: Role) {
    if (!currentOrg) return;
    const ok = await confirm({
      title: `Delete role "${role.name}"?`,
      description: "This cannot be undone. Members with this role will lose these permissions.",
      confirmLabel: "Delete role",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.delete(`/orgs/${currentOrg.id}/roles/${role.id}`);
      loadRoles();
    } catch (e) {
      setError(
        e instanceof Error ? `Could not delete: ${e.message}` : "Could not delete.",
      );
    }
  }

  async function handleAssign(role: Role, userId: string) {
    if (!currentOrg || !userId.trim()) return;
    try {
      await api.post(`/orgs/${currentOrg.id}/roles/${role.id}/assignments`, {
        user_id: userId.trim(),
      });
      loadAssignments(role.id);
    } catch (e) {
      setError(
        e instanceof Error ? `Could not assign: ${e.message}` : "Could not assign.",
      );
    }
  }

  if (!currentOrg) return null;

  if (loading && !roles) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Shield className="w-5 h-5 text-[var(--accent)]" />
            Custom roles
          </h3>
          <p className="text-sm text-[var(--text-muted)] mt-1 max-w-2xl">
            Define custom roles with arbitrary permission sets. Custom roles inherit
            from a built-in base role (owner / admin / member / viewer) and
            add their own permissions. Assign to users below; assignments
            can be org-wide or scoped to a single resource.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)]"
        >
          <Plus className="w-4 h-4" />
          New role
        </button>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <Info className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {showCreate && (
        <CreateRoleForm
          onCancel={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      )}

      {roles && roles.length === 0 && (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-8 text-center">
          <Shield className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
            No custom roles yet
          </h3>
          <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto">
            Click "New role" to define one. Custom roles are scoped to this org
            and inherit from a built-in base role.
          </p>
        </div>
      )}

      {roles && roles.length > 0 && (
        <div className="space-y-2">
          {roles.map((role) => (
            <RoleRow
              key={role.id}
              role={role}
              expanded={expandedRoleId === role.id}
              onToggle={() => {
                const next = expandedRoleId === role.id ? null : role.id;
                setExpandedRoleId(next);
                if (next) loadAssignments(next);
              }}
              assignments={assignments[role.id] ?? null}
              onDelete={() => handleDelete(role)}
              onAssign={(userId) => handleAssign(role, userId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RoleRow({
  role,
  expanded,
  onToggle,
  assignments,
  onDelete,
  onAssign,
}: {
  role: Role;
  expanded: boolean;
  onToggle: () => void;
  assignments: Assignment[] | null;
  onDelete: () => void;
  onAssign: (userId: string) => void;
}) {
  const [assignUserId, setAssignUserId] = useState("");

  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--bg-tertiary)]/30">
        <button
          onClick={onToggle}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text-primary)]">
              {role.name}
            </span>
            <span className="text-xs px-2 py-0.5 bg-[var(--bg-tertiary)] text-[var(--text-muted)] rounded-full font-mono">
              base: {role.base_role}
            </span>
          </div>
          {role.description && (
            <div className="text-xs text-[var(--text-muted)] mt-0.5">
              {role.description}
            </div>
          )}
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          {role.permissions.length} permission{role.permissions.length === 1 ? "" : "s"}
        </div>
        <button
          onClick={onDelete}
          className="text-[var(--text-muted)] hover:text-[var(--error)] transition-colors"
          title="Delete role"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {expanded && (
        <div className="px-4 py-4 border-t border-[var(--border-default)] space-y-4">
          {/* Permission chips */}
          <div>
            <div className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
              Effective permissions
            </div>
            {role.permissions.length === 0 ? (
              <div className="text-xs text-[var(--text-muted)] italic">
                No additional permissions (inherits base role only).
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {role.permissions.map((p) => (
                  <span
                    key={p}
                    className="text-xs px-2 py-1 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded font-mono"
                  >
                    {p}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Assignments */}
          <div>
            <div className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
              Assignments
            </div>
            {assignments === null ? (
              <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
            ) : assignments.length === 0 ? (
              <div className="text-xs text-[var(--text-muted)] italic">
                No users assigned yet.
              </div>
            ) : (
              <ul className="space-y-1 text-sm">
                {assignments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 text-[var(--text-secondary)] font-mono text-xs"
                  >
                    <Check className="w-3 h-3 text-[var(--terminal)]" />
                    {a.user_id}
                    {a.resource_type && (
                      <span className="text-[var(--text-muted)]">
                        (scoped to {a.resource_type}:{a.resource_id})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Assign form */}
            <div className="mt-3 flex items-center gap-2">
              <input
                type="text"
                value={assignUserId}
                onChange={(e) => setAssignUserId(e.target.value)}
                placeholder="user_id (UUID)"
                className="flex-1 text-sm border border-[var(--border-default)] rounded-lg px-3 py-1.5 bg-[var(--bg-primary)] text-[var(--text-primary)] font-mono"
              />
              <button
                onClick={() => {
                  onAssign(assignUserId);
                  setAssignUserId("");
                }}
                disabled={!assignUserId.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Assign
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateRoleForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (form: {
    name: string;
    base_role: string;
    description: string;
    permissions: string[];
  }) => void;
}) {
  const [name, setName] = useState("");
  const [baseRole, setBaseRole] = useState<(typeof BASE_ROLES)[number]>("viewer");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(perm: string) {
    const next = new Set(selected);
    if (next.has(perm)) next.delete(perm);
    else next.add(perm);
    setSelected(next);
  }

  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">
          New custom role
        </h4>
        <button
          onClick={onCancel}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="reviewer"
              className="w-full text-sm border border-[var(--border-default)] rounded-lg px-3 py-1.5 bg-[var(--bg-primary)] text-[var(--text-primary)]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Inherits from
            </label>
            <select
              value={baseRole}
              onChange={(e) =>
                setBaseRole(e.target.value as (typeof BASE_ROLES)[number])
              }
              className="w-full text-sm border border-[var(--border-default)] rounded-lg px-3 py-1.5 bg-[var(--bg-primary)] text-[var(--text-primary)]"
            >
              {BASE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
            Description
          </label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this role for?"
            className="w-full text-sm border border-[var(--border-default)] rounded-lg px-3 py-1.5 bg-[var(--bg-primary)] text-[var(--text-primary)]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-2">
            Additional permissions (on top of the base role)
          </label>
          <div className="space-y-2">
            {PERMISSION_PRESETS.map((preset) => (
              <div key={preset.category}>
                <div className="text-xs font-medium text-[var(--text-secondary)] mb-1">
                  {preset.category}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {preset.permissions.map((p) => (
                    <button
                      key={p}
                      onClick={() => toggle(p)}
                      className={cn(
                        "text-xs px-2 py-1 rounded font-mono border transition-colors",
                        selected.has(p)
                          ? "bg-[var(--accent)] text-[var(--bg-base)] border-[var(--accent)]"
                          : "bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[var(--accent)]"
                      )}
                    >
                      {selected.has(p) ? "✓ " : "+ "}
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 mt-5">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() =>
            onSubmit({
              name: name.trim(),
              base_role: baseRole,
              description: description.trim(),
              permissions: Array.from(selected),
            })
          }
          disabled={!name.trim()}
          className="px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          Create role
        </button>
      </div>
    </div>
  );
}
