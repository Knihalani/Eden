import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { Building2, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

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

const CREATE_ORG_HREF = "/settings?tab=org";

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
  const orglessDescription =
    "Create an organization in Settings → Organization to unlock this feature. The product tour does not create or sync your workspace.";
  const timeoutDescription =
    "Workspace sync is taking longer than expected. Refresh to retry linking, or create an organization in Settings → Organization. The product tour does not create or sync your workspace.";

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

  const createOrgPrimary =
    secondaryAction ?? (
      <Button asChild variant="default" className="min-h-11">
        <Link href={CREATE_ORG_HREF}>Create organization</Link>
      </Button>
    );

  const createOrgSecondary = (
    <Link
      href={CREATE_ORG_HREF}
      className="inline-flex min-h-11 items-center text-sm text-[var(--accent)] hover:underline"
    >
      Open Organization settings
    </Link>
  );

  return (
    <div className={cn("flex flex-col items-center justify-center min-h-[50vh] p-6 text-center", className)}>
      <div className="w-14 h-14 rounded-2xl bg-[var(--bg-tertiary)] border border-[var(--border-default)] flex items-center justify-center mb-5">
        <Icon className="w-7 h-7 text-[var(--text-muted)]" aria-hidden />
      </div>
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
        {syncTimedOut ? "Workspace sync timed out" : "No workspace yet"}
      </h2>
      <p className="text-sm text-[var(--text-secondary)] max-w-md mb-5">
        {syncTimedOut
          ? (description ?? timeoutDescription)
          : (description ?? orglessDescription)}
      </p>
      <div className="flex flex-col items-center gap-3">
        {syncTimedOut ? (
          <>
            {onRetrySync ? (
              <Button
                type="button"
                variant="default"
                className="min-h-11"
                onClick={onRetrySync}
              >
                <RefreshCw className="w-4 h-4" />
                Retry sync
              </Button>
            ) : null}
            {secondaryAction ?? createOrgSecondary}
          </>
        ) : (
          <>
            {createOrgPrimary}
            {onRetrySync ? (
              <button
                type="button"
                onClick={onRetrySync}
                className="inline-flex min-h-11 items-center gap-2 px-4 py-2 border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
            ) : null}
          </>
        )}
      </div>
      <p className="text-xs text-[var(--text-muted)] mt-3">
        {feature} is unavailable until your workspace is linked.
      </p>
    </div>
  );
}
