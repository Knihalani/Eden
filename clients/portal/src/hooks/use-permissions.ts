"use client";

import { useMemo } from "react";
import { useOrg } from "@/hooks/use-org";

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
  | "org:transfer";

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
    "org:transfer",
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
  ],
  member: ["references:read", "jobs:read", "jobs:write"],
  viewer: ["references:read", "jobs:read"],
};

export interface UsePermissionsResult {
  permissions: Set<Permission>;
  hasPermission: (permission: Permission) => boolean;
  role: string | null;
}

export function usePermissions(): UsePermissionsResult {
  const { currentOrg } = useOrg();

  return useMemo(() => {
    if (!currentOrg?.role) {
      return {
        permissions: new Set<Permission>(),
        hasPermission: () => false,
        role: null,
      };
    }

    const role = currentOrg.role;
    const permissions = new Set<Permission>(PERMISSION_MAP[role] || []);

    return {
      permissions,
      hasPermission: (permission: Permission) => permissions.has(permission),
      role,
    };
  }, [currentOrg?.role]);
}

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

// Role badge colors — token-based so a palette swap propagates. The
// mapping is intentional: owner is the highest-privilege role (warm
// amber/warning token), admin is the primary accent (blue), member is
// the success/terminal green, viewer is the muted neutral.
export const ROLE_COLORS: Record<string, string> = {
  owner: "border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)]",
  admin: "border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]",
  member: "border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]",
  viewer: "border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
};