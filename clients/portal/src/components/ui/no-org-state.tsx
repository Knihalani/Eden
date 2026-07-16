import Link from "next/link";
import { Building2, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface NoOrgStateProps {
  feature: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  /** Clerk has an org but Eden hasn't synced yet */
  syncing?: boolean;
  /** Sync waited too long — show manual recovery instead of spinner */
  syncTimedOut?: boolean;
  onRetrySync?: () => void;
}

export function NoOrgState({
  feature,
  description = "Your workspace is being set up. This usually takes a few seconds after signup.",
  icon: Icon = Building2,
  className,
  syncing = false,
  syncTimedOut = false,
  onRetrySync,
}: NoOrgStateProps) {
  if (syncing && !syncTimedOut) {
    return (
      <div className={cn("flex flex-col items-center justify-center min-h-[50vh] p-6 text-center", className)}>
        <Loader2 className="w-10 h-10 text-[var(--accent)] animate-spin mb-4" />
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
          Syncing your workspace…
        </h2>
        <p className="text-sm text-[var(--text-secondary)] max-w-sm mb-5">
          Clerk created your organization at signup. Eden is linking it now.
        </p>
        {onRetrySync && (
          <button
            type="button"
            onClick={onRetrySync}
            className="inline-flex items-center gap-2 px-4 py-2 border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col items-center justify-center min-h-[50vh] p-6 text-center", className)}>
      <div className="w-14 h-14 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-default)] flex items-center justify-center mb-5">
        <Icon className="w-7 h-7 text-[var(--text-muted)]" />
      </div>
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
        No workspace yet
      </h2>
      <p className="text-sm text-[var(--text-secondary)] max-w-sm mb-5">
        {description}
      </p>
      <Link
        href="/dashboard?onboarding=1"
        className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
      >
        <Building2 className="w-4 h-4" />
        Finish setup
      </Link>
      <p className="text-xs text-[var(--text-faint)] mt-3">
        {feature} is unavailable until your workspace is linked.
      </p>
    </div>
  );
}
