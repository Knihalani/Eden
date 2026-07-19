import type { ComponentType, ReactNode } from "react";
import { Building2, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface NoOrgStateProps {
  feature: string;
  description?: string;
  icon?: ComponentType<{ className?: string }>;
  className?: string;
  /** Clerk has an org but Eden hasn't synced yet */
  syncing?: boolean;
  /** Sync waited too long — show manual recovery instead of spinner */
  syncTimedOut?: boolean;
  onRetrySync?: () => void;
  /** Optional secondary CTA (e.g. link to Organization settings). Never a tour link. */
  secondaryAction?: ReactNode;
}

export function NoOrgState({
  feature,
  description,
  icon: Icon = Building2,
  className,
  syncing = false,
  syncTimedOut = false,
  onRetrySync,
  secondaryAction,
}: NoOrgStateProps) {
  const setupDescription =
    "Your workspace is being set up. This usually takes a few seconds after signup.";
  const timeoutDescription =
    "Workspace sync is taking longer than expected. Refresh to try again — the product tour does not create or sync your organization.";

  if (syncing && !syncTimedOut) {
    return (
      <div className={cn("flex flex-col items-center justify-center min-h-[50vh] p-6 text-center", className)}>
        <Loader2 className="w-10 h-10 text-[var(--accent)] animate-spin mb-4" aria-hidden />
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
            className="inline-flex min-h-11 items-center gap-2 px-4 py-2 border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
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
        <Icon className="w-7 h-7 text-[var(--text-muted)]" aria-hidden />
      </div>
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
        {syncTimedOut ? "Workspace sync timed out" : "No workspace yet"}
      </h2>
      <p className="text-sm text-[var(--text-secondary)] max-w-sm mb-5">
        {syncTimedOut
          ? (description ?? timeoutDescription)
          : (description ?? setupDescription)}
      </p>
      {onRetrySync ? (
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={onRetrySync}
            className="inline-flex min-h-11 items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh workspace
          </button>
          {secondaryAction}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--text-muted)] max-w-sm">
            Select or create an organization in the account menu, then refresh. Do not use the
            product tour to create an org — it does not sync your workspace.
          </p>
          {secondaryAction}
        </div>
      )}
      <p className="text-xs text-[var(--text-muted)] mt-3">
        {feature} is unavailable until your workspace is linked.
      </p>
    </div>
  );
}
