"use client";

import { useMemo } from "react";
import { useOrg } from "@/hooks/use-org";
import { clerkRoleToEden } from "@/lib/roles";

export type Permission =
  | "references:read"
  | "references:upload"
  | "references:delete"
  | "members:invite"
  | "members:remove"
  | "settings:edit"
  | "billing:view"
  | "billing:edit"
  | "audit:view"
  | "jobs:read"
  | "jobs:write"
  | "integrations:write"
  | "org:transfer"
  // Phase 7.3d — mirrors src/eden/api/deps.py PERMISSION_MAP
  | "pii:edit"
  | "judges:run"
  | "gdpr:execute"
  | "retention:override";

const PERMISSION_MAP: Record<string, Permission[]> = {
  owner: [
    "references:read",
    "references:upload",
    "references:delete",
    "members:invite",
    "members:remove",
    "settings:edit",
    "billing:view",
    "billing:edit",
    "audit:view",
    "jobs:read",
    "jobs:write",
    "integrations:write",
    "org:transfer",
    "pii:edit",
    "judges:run",
    "gdpr:execute",
    "retention:override",
  ],
  admin: [
    "references:read",
    "references:upload",
    "references:delete",
    "members:invite",
    "members:remove",
    "settings:edit",
    "billing:view",
    "audit:view",
    "jobs:read",
    "jobs:write",
    "integrations:write",
    "pii:edit",
    "judges:run",
  ],
  member: ["references:read", "jobs:read", "jobs:write", "judges:run"],
  viewer: ["references:read", "jobs:read"],
};

export interface UsePermissionsResult {
  permissions: Set<Permission>;
  hasPermission: (permission: Permission) => boolean;
  role: string | null;
}

/**
 * Resolve Eden role with Clerk / owner fallbacks.
 *
 * Prefer the Eden DB role from ``/auth/me`` when present. Clerk's
 * membership role is only a fallback for sync lag (e.g. org creators
 * briefly have Clerk ``org:admin`` while ``/auth/me`` still omits
 * ``role``). Without the Clerk map, Connect-repo CTAs and owner-only
 * actions lock out the person who just created the workspace.
 */
export function resolveRole(
  currentOrg: { role?: string; is_owner?: boolean } | null,
  clerkOrgRole: string | null,
): string | null {
  const edenRole = currentOrg?.role;
  if (edenRole && PERMISSION_MAP[edenRole]) return edenRole;
  if (currentOrg?.is_owner) return "owner";
  if (clerkOrgRole) {
    const mapped = clerkRoleToEden(clerkOrgRole);
    if (PERMISSION_MAP[mapped]) return mapped;
  }
  return edenRole || null;
}

export function usePermissions(): UsePermissionsResult {
  const { currentOrg, clerkOrgRole } = useOrg();

  return useMemo(() => {
    const role = resolveRole(currentOrg, clerkOrgRole);
    if (!role) {
      return {
        permissions: new Set<Permission>(),
        hasPermission: () => false,
        role: null,
      };
    }

    const permissions = new Set<Permission>(PERMISSION_MAP[role] || []);

    return {
      permissions,
      hasPermission: (permission: Permission) => permissions.has(permission),
      role,
    };
  }, [currentOrg, clerkOrgRole]);
}
