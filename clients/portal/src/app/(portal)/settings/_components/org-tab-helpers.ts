import { cn } from "@/lib/utils";

/** Normalize a workspace slug to URL-safe lowercase kebab. */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function roleBadgeClass(role: string | undefined, isOwner: boolean): string {
  return cn(
    "px-space-2 py-space-1 rounded-md text-sm font-medium",
    isOwner
      ? "bg-[var(--warning-bg)] text-[var(--warning)]"
      : role === "admin"
        ? "bg-[var(--accent-faint)] text-[var(--accent)]"
        : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  );
}

export function dangerZoneDescription(isPersonal: boolean): string {
  return isPersonal
    ? "Archiving or deleting a personal workspace is irreversible."
    : "Archiving, deleting, or transferring a workspace is irreversible. Make sure all admins have a backup plan.";
}

export type TransferMember = {
  user_id: string;
  name: string;
  email: string;
  role: string;
};
