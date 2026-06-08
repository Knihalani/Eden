import Link from "next/link";
import { Building2, type LucideIcon } from "lucide-react";

interface NoOrgStateProps {
  feature: string;
  description?: string;
  icon?: LucideIcon;
}

export function NoOrgState({
  feature,
  description = "Create an organization to start using this feature and collaborating with your team.",
  icon: Icon = Building2,
}: NoOrgStateProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-default)] flex items-center justify-center mb-5">
        <Icon className="w-7 h-7 text-[var(--text-muted)]" />
      </div>
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
        No organization yet
      </h2>
      <p className="text-sm text-[var(--text-secondary)] max-w-sm mb-5">
        {description}
      </p>
      <Link
        href="/settings"
        className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
      >
        <Building2 className="w-4 h-4" />
        Create Organization
      </Link>
      <p className="text-xs text-[var(--text-faint)] mt-3">
        {feature} is unavailable until you join or create an organization.
      </p>
    </div>
  );
}
