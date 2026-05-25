"use client";

import { usePermissions, ROLE_LABELS, ROLE_COLORS } from "@/hooks/use-permissions";

interface RoleBadgeProps {
  role?: string | null;
  showPermissions?: boolean;
}

export function RoleBadge({ role, showPermissions = false }: RoleBadgeProps) {
  const { permissions } = usePermissions();

  if (!role) return null;

  const colorClass = ROLE_COLORS[role] || "bg-gray-100 text-gray-700 border-gray-300";
  const label = ROLE_LABELS[role] || role;

  return (
    <div className="flex flex-col gap-2">
      <span className={`px-2 py-1 rounded-md text-sm font-medium border ${colorClass}`}>
        {label}
      </span>
      {showPermissions && (
        <div className="flex flex-wrap gap-1 mt-1">
          {permissions.size > 0 ? (
            Array.from(permissions).map((perm) => (
              <span
                key={perm}
                className="px-1.5 py-0.5 bg-[var(--bg-muted)] text-[var(--text-muted)] text-xs rounded"
              >
                {perm}
              </span>
            ))
          ) : (
            <span className="text-xs text-[var(--text-muted)]">View only</span>
          )}
        </div>
      )}
    </div>
  );
}