"use client";

/**
 * ChromeBanners — at most one portal chrome attention banner.
 *
 * Priority (highest first):
 *   1. auth session/error
 *   2. offline
 *   3. org syncing
 *
 * OnboardingBanner stays separate (rendered by portal chrome) and should
 * collapse when auth owns attention: ``collapsed={!!showAuthBanner}``.
 */

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Loader2,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type ChromeAttentionBanner = "auth" | "offline" | "org-syncing";

export type ChromeBannersProps = {
  online: boolean;
  showAuthBanner: boolean;
  isSessionAuthError: boolean;
  authError: string | null;
  showOrgSyncingBanner: boolean;
  /**
   * When true, suppress all chrome attention banners (e.g. parent wants a
   * quieter shell). Does not affect OnboardingBanner — pass
   * ``collapsed={!!showAuthBanner}`` there separately.
   */
  collapsed?: boolean;
  clearAuthError: () => void;
  refreshUserWithRetry: () => Promise<unknown>;
  refreshOrgs: () => void | Promise<unknown>;
  onSignIn: () => void;
};

/** Resolve which attention banner wins. Returns null when none / collapsed. */
export function resolveChromeAttentionBanner({
  online,
  showAuthBanner,
  showOrgSyncingBanner,
  collapsed = false,
}: {
  online: boolean;
  showAuthBanner: boolean;
  showOrgSyncingBanner: boolean;
  collapsed?: boolean;
}): ChromeAttentionBanner | null {
  if (collapsed) return null;
  if (showAuthBanner) return "auth";
  if (!online) return "offline";
  if (showOrgSyncingBanner) return "org-syncing";
  return null;
}

/** Parent wiring for OnboardingBanner — collapse when auth banner wins. */
export function shouldCollapseOnboardingBanner(
  showAuthBanner: boolean,
): boolean {
  return !!showAuthBanner;
}

export function ChromeBanners({
  online,
  showAuthBanner,
  isSessionAuthError,
  authError,
  showOrgSyncingBanner,
  collapsed = false,
  clearAuthError,
  refreshUserWithRetry,
  refreshOrgs,
  onSignIn,
}: ChromeBannersProps) {
  const active = resolveChromeAttentionBanner({
    online,
    showAuthBanner,
    showOrgSyncingBanner,
    collapsed,
  });

  if (active === "auth") {
    return (
      <div
        role="alert"
        className={
          isSessionAuthError
            ? "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-3 bg-[var(--error-dim)] border-b border-[var(--error)]/30 text-sm"
            : "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-3 bg-[var(--warning-bg)] border-b border-[var(--warning)]/30 text-sm"
        }
      >
        <div className="flex items-start gap-2 min-w-0">
          <AlertTriangle
            className={
              isSessionAuthError
                ? "w-4 h-4 text-[var(--error)] shrink-0 mt-0.5"
                : "w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5"
            }
          />
          <span
            className={
              isSessionAuthError
                ? "text-[var(--error)]"
                : "text-[var(--warning)]"
            }
          >
            {authError ??
              (isSessionAuthError
                ? "Session expired. Please sign in again."
                : "Eden is having trouble reaching the server. Please try again in a moment.")}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void (async () => {
                clearAuthError();
                await refreshUserWithRetry();
                await refreshOrgs();
              })();
            }}
            aria-label="Retry loading session"
            className={
              isSessionAuthError
                ? "border-[var(--error)]/40 text-[var(--error)] hover:bg-[var(--error)]/10"
                : "border-[var(--warning)]/40 text-[var(--warning)] hover:bg-[var(--warning)]/10"
            }
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </Button>
          {isSessionAuthError ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onSignIn}
            >
              Sign in
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (active === "offline") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 px-4 sm:px-6 py-2.5 bg-[var(--warning-bg)] border-b border-[var(--warning)]/30 text-sm"
      >
        <WifiOff className="w-4 h-4 text-[var(--warning-strong)] shrink-0" />
        <span className="text-[var(--warning-strong)] truncate">
          You&rsquo;re offline. Showing the last data Eden loaded — changes will
          retry once your connection returns.
        </span>
      </div>
    );
  }

  if (active === "org-syncing") {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 bg-[var(--bg-primary)] border-b border-[var(--border-default)] text-sm"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Loader2 className="w-4 h-4 text-[var(--accent)] shrink-0 animate-spin" />
          <span className="text-[var(--text-secondary)] truncate">
            Syncing your workspace from Clerk…
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/settings?tab=org"
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:underline"
          >
            Resume setup
          </Link>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refreshOrgs()}
            aria-label="Refresh workspace sync"
            className="text-[var(--text-secondary)]"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
