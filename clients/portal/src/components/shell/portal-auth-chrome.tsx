"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { OrganizationSwitcher, UserButton, useAuth as useClerkAuth } from "@clerk/nextjs";
import { useOrg } from "@/hooks/use-org";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api/resources";
import { cn } from "@/lib/utils";

/** Compact Clerk user + org controls for the sidebar footer. */
export function SidebarAuthFooter({ collapsed }: { collapsed: boolean }) {
  const { isSignedIn } = useClerkAuth();
  if (!isSignedIn) {
    return (
      <div
        className={cn(
          "shrink-0 border-t border-[var(--line)]",
          collapsed ? "px-1 py-2" : "px-2.5 py-2",
        )}
      >
        <Link
          href="/sign-in"
          className={cn(
            "type-ui ds-nav-item justify-center",
            collapsed && "!px-0",
          )}
        >
          {collapsed ? "…" : "Sign in"}
        </Link>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-2 border-t border-[var(--line)]",
        collapsed ? "items-center px-1 py-2" : "px-2.5 py-2.5",
      )}
    >
      {!collapsed ? (
        <OrganizationSwitcher
          hidePersonal={false}
          afterSelectOrganizationUrl="/home"
          afterCreateOrganizationUrl="/home"
          appearance={{
            elements: {
              rootBox: "w-full",
              organizationSwitcherTrigger:
                "w-full justify-between rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg)] px-2 py-1.5 text-left text-[0.8125rem] text-[var(--text)]",
            },
          }}
        />
      ) : null}
      <div className={cn("flex items-center", collapsed ? "justify-center" : "gap-2")}>
        <UserButton
          appearance={{
            elements: {
              avatarBox: "h-7 w-7",
            },
          }}
        />
        {!collapsed ? (
          <span className="type-meta truncate text-[var(--text-faint)]">Account</span>
        ) : null}
      </div>
    </div>
  );
}

/** Top banners for auth/org sync failures and no-org empty. */
export function PortalStatusBanners() {
  const {
    currentOrg,
    organizations,
    loading,
    authError,
    authErrorKind,
    clearAuthError,
    orgSyncing,
    orgSyncTimedOut,
    refreshOrgs,
  } = useOrg();
  const { refreshUserWithRetry } = useAuth();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const onCreateWorkspace = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await api.createOrg("My workspace", true);
      await refreshOrgs();
      await refreshUserWithRetry();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Could not create workspace");
    } finally {
      setCreating(false);
    }
  }, [refreshOrgs, refreshUserWithRetry]);

  if (loading && !currentOrg && organizations.length === 0 && !authError) {
    return (
      <div
        className="border-b border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-2"
        role="status"
      >
        <p className="type-meta text-[var(--text-faint)]">Loading workspace…</p>
      </div>
    );
  }

  if (authError && authErrorKind === "session") {
    return (
      <div
        className="flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-2"
        role="alert"
      >
        <p className="type-meta text-[var(--text)]">
          Session expired. Sign in again to continue.
        </p>
        <Link href="/sign-in" className="ds-btn ds-btn-primary ds-btn-sm shrink-0">
          Sign in
        </Link>
      </div>
    );
  }

  if (authError && authErrorKind === "server") {
    return (
      <div
        className="flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-2"
        role="alert"
      >
        <p className="type-meta text-[var(--text)]">{authError}</p>
        <button
          type="button"
          className="ds-btn ds-btn-secondary ds-btn-sm shrink-0"
          onClick={() => {
            clearAuthError();
            void refreshOrgs();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (orgSyncing) {
    return (
      <div
        className="border-b border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-2"
        role="status"
      >
        <p className="type-meta text-[var(--text-faint)]">
          Syncing organization with Eden…
          {orgSyncTimedOut ? " Taking longer than usual." : null}
        </p>
      </div>
    );
  }

  if (!loading && !currentOrg && organizations.length === 0 && !authError) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-2.5"
        role="status"
      >
        <div className="min-w-0">
          <p className="type-ui text-[var(--text)]">No workspace yet</p>
          <p className="type-meta text-[var(--text-faint)]">
            Create a workspace to start ingesting traces and managing agents.
          </p>
          {createError ? (
            <p className="type-meta mt-1 text-[var(--danger)]">{createError}</p>
          ) : null}
        </div>
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm shrink-0"
          disabled={creating}
          onClick={() => void onCreateWorkspace()}
        >
          {creating ? "Creating…" : "Create workspace"}
        </button>
      </div>
    );
  }

  return null;
}

/** Full-page gate while Clerk + org bootstrap. */
export function PortalBootGate({ children }: { children: React.ReactNode }) {
  const { loading: authLoading } = useAuth();
  const { loading: orgLoading, currentOrg, organizations, authError } = useOrg();
  const { isLoaded: clerkLoaded, isSignedIn } = useClerkAuth();

  if (!clerkLoaded || (isSignedIn && (authLoading || orgLoading) && !currentOrg && !authError && organizations.length === 0)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--bg)]">
        <p className="type-meta text-[var(--text-faint)]">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
}
