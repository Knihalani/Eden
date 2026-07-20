"use client";

import { usePermissions, type Permission } from "@/hooks/use-permissions";
import { Card } from "@/components/ui/card";
import { ShieldOff } from "lucide-react";

interface PermissionGateProps {
  /** The permission required to render `children`. */
  permission: Permission;
  /** Optional fallback shown when the user lacks the permission. */
  fallback?: React.ReactNode;
  /** Content shown when the user has the permission. Optional for deny-only gates. */
  children?: React.ReactNode;
}

/**
 * PermissionGate — render `children` only if the current user has
 * `permission`. Otherwise show a permission-denied card (or the
 * supplied fallback). Replaces the manual
 *   if (!hasPermission("x")) return <Denied />;
 * pattern that was copy-pasted across settings tabs.
 *
 * Phase 7 of the June 2026 UI overhaul.
 */
export function PermissionGate({ permission, fallback, children }: PermissionGateProps) {
  const { hasPermission } = usePermissions();
  if (hasPermission(permission)) return <>{children}</>;
  return (
    <>
      {fallback ?? (
        <Card padding="xl" className="text-center">
          <ShieldOff className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
          <h3 className="text-base font-semibold text-[var(--text-primary)]">
            You don&apos;t have access to this section
          </h3>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            This view requires the <code className="font-mono">{permission}</code> permission.
            Ask an org admin to grant it.
          </p>
        </Card>
      )}
    </>
  );
}
