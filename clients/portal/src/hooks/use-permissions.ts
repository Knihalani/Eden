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

export const ROLE_COLORS: Record<string, string> = {
  owner: "bg-yellow-100 text-yellow-800 border-yellow-300",
  admin: "bg-blue-100 text-blue-800 border-blue-300",
  member: "bg-green-100 text-green-800 border-green-300",
  viewer: "bg-gray-100 text-gray-700 border-gray-300",
};