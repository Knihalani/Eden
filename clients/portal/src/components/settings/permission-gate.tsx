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
 * supplied fallback).
 */
export function PermissionGate({ permission, fallback, children }: PermissionGateProps) {
  const { hasPermission } = usePermissions();
  if (hasPermission(permission)) return <>{children}</>;

  const humanLabel = permission.replace(":", " · ").replace(/_/g, " ");

  return (
    <>
      {fallback ?? (
        <Card padding="xl" className="text-center">
          <ShieldOff className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
          <h3 className="text-base font-semibold text-[var(--text-primary)]">
            You need an admin to open this
          </h3>
          <p className="mt-1 text-sm text-[var(--text-muted)] max-w-md mx-auto">
            This section is limited to teammates with{" "}
            <span className="text-[var(--text-secondary)]">{humanLabel}</span> access.
            Ask an organization owner or admin if you need it.
          </p>
        </Card>
      )}
    </>
  );
}
