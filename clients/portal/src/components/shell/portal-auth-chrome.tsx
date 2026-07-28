"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useAuth as useClerkAuth,
  useClerk,
  useOrganizationList,
  useUser,
} from "@clerk/nextjs";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, LogOut } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api/auth-api";
import { CHROME_BANNER_ATTR } from "@/lib/overlay-defer";
import { dropOrgScopedQueries } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import type { Organization } from "@/lib/types";

/** Marks ``<html>`` so the product tour defers while chrome banners show. */
function ChromeBannerMark({ active }: { active: boolean }) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (active) {
      root.setAttribute(CHROME_BANNER_ATTR, "1");
      return () => {
        root.removeAttribute(CHROME_BANNER_ATTR);
      };
    }
    root.removeAttribute(CHROME_BANNER_ATTR);
  }, [active]);
  return null;
}

function useDismissibleOpen(initial = false) {
  const [open, setOpen] = useState(initial);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, rootRef };
}

/** Eden workspace picker — no Clerk OrganizationSwitcher (avoids clerk.ui). */
function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { currentOrg, organizations } = useOrg();
  const { setActive, isLoaded } = useOrganizationList();
  const { open, setOpen, rootRef } = useDismissibleOpen();
  const router = useRouter();
  const queryClient = useQueryClient();
  const listId = useId();
  const [busy, setBusy] = useState(false);

  const label = currentOrg?.name ?? "Select workspace";
  const ariaLabel = `Switch workspace: ${label}`;

  const onSelect = useCallback(
    async (org: Organization) => {
      if (!setActive || busy) return;
      const clerkId = org.clerk_org_id || org.id;
      if (!clerkId) return;
      if (currentOrg?.id === org.id) {
        setOpen(false);
        return;
      }
      setBusy(true);
      try {
        await setActive({ organization: clerkId });
        setOpen(false);
        // Soft navigate — hard assign used to flash a full reload.
        // Drop cached org shards so the new workspace cannot paint
        // stale agents/traces under the previous org id.
        await queryClient.cancelQueries();
        dropOrgScopedQueries(queryClient);
        router.push("/home");
        router.refresh();
      } catch {
        /* keep picker open */
      } finally {
        setBusy(false);
      }
    },
    [busy, currentOrg?.id, queryClient, router, setActive, setOpen],
  );

  if (collapsed) {
    const initial = (currentOrg?.name ?? "?").slice(0, 1).toUpperCase();
    return (
      <div ref={rootRef} className="relative">
        <button
          type="button"
          className="ds-btn ds-btn-ghost flex h-8 w-8 items-center justify-center !px-0"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listId}
          disabled={!isLoaded || busy}
          onClick={() => setOpen((v) => !v)}
          title={label}
        >
          <span className="type-ui text-[var(--accent)]">{initial}</span>
        </button>
        {open ? (
          <WorkspaceMenu
            id={listId}
            organizations={organizations}
            currentId={currentOrg?.id}
            onSelect={onSelect}
            className="absolute bottom-full left-0 z-50 mb-1 w-56"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg)] px-2 py-1.5 text-left text-[0.8125rem] text-[var(--text)]",
          "hover:border-[var(--line-accent)]",
        )}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        disabled={!isLoaded || busy || organizations.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)]"
          aria-hidden
        />
      </button>
      {open ? (
        <WorkspaceMenu
          id={listId}
          organizations={organizations}
          currentId={currentOrg?.id}
          onSelect={onSelect}
          className="absolute bottom-full left-0 z-50 mb-1 w-full min-w-[12rem]"
        />
      ) : null}
    </div>
  );
}

function WorkspaceMenu({
  id,
  organizations,
  currentId,
  onSelect,
  className,
}: {
  id: string;
  organizations: Organization[];
  currentId?: string;
  onSelect: (org: Organization) => void;
  className?: string;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Workspaces"
      className={cn(
        "max-h-60 overflow-auto rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)]",
        className,
      )}
    >
      {organizations.length === 0 ? (
        <li className="px-2.5 py-2 type-meta text-[var(--text-faint)]">
          No workspaces
        </li>
      ) : (
        organizations.map((org) => {
          const selected = org.id === currentId;
          return (
            <li key={org.id} role="option" aria-selected={selected}>
              <button
                type="button"
                className={cn(
                  "flex w-full px-2.5 py-1.5 text-left text-[0.8125rem]",
                  selected
                    ? "bg-[var(--accent-muted)] text-[var(--accent)]"
                    : "text-[var(--text)] hover:bg-[var(--bg-elevated)]",
                )}
                onClick={() => onSelect(org)}
              >
                <span className="truncate">{org.name}</span>
              </button>
            </li>
          );
        })
      )}
    </ul>
  );
}

/** Lightweight account menu — no Clerk UserButton (avoids clerk.ui). */
function AccountMenu({ collapsed }: { collapsed: boolean }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { open, setOpen, rootRef } = useDismissibleOpen();
  const menuId = useId();

  const name =
    user?.fullName ||
    user?.primaryEmailAddress?.emailAddress ||
    user?.username ||
    "Account";
  const imageUrl = user?.imageUrl;
  const initial = name.slice(0, 1).toUpperCase();
  const ariaLabel = `Account menu: ${name}`;

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative flex items-center",
        collapsed ? "justify-center" : "gap-2",
      )}
    >
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--line)] bg-[var(--bg-elevated)]"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="type-meta text-[var(--text)]">{initial}</span>
        )}
      </button>
      {!collapsed ? (
        <span className="type-meta truncate text-[var(--text-faint)]">
          Account
        </span>
      ) : null}
      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-1 min-w-[11rem] overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        >
          <p className="truncate border-b border-[var(--line)] px-2.5 py-1.5 type-meta text-[var(--text-faint)]">
            {name}
          </p>
          <Link
            href="/settings"
            role="menuitem"
            className="block px-2.5 py-1.5 text-[0.8125rem] text-[var(--text)] hover:bg-[var(--bg-elevated)]"
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.8125rem] text-[var(--text)] hover:bg-[var(--bg-elevated)]"
            onClick={() => void signOut({ redirectUrl: "/" })}
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Compact user + org controls for the sidebar footer. */
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
      <WorkspaceSwitcher collapsed={collapsed} />
      <AccountMenu collapsed={collapsed} />
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
      setCreateError(
        e instanceof Error ? e.message : "Could not create workspace",
      );
    } finally {
      setCreating(false);
    }
  }, [refreshOrgs, refreshUserWithRetry]);

  const loadingBanner =
    loading && !currentOrg && organizations.length === 0 && !authError;
  const sessionBanner = Boolean(authError && authErrorKind === "session");
  const serverBanner = Boolean(authError && authErrorKind === "server");
  const syncBanner = Boolean(orgSyncing);
  const emptyBanner =
    !loading && !currentOrg && organizations.length === 0 && !authError;
  const showChromeBanner =
    loadingBanner ||
    sessionBanner ||
    serverBanner ||
    syncBanner ||
    emptyBanner;

  let banner: ReactNode = null;
  if (loadingBanner) {
    banner = (
      <div
        className="border-b border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-2"
        role="status"
      >
        <p className="type-meta text-[var(--text-faint)]">
          Loading workspace…
        </p>
      </div>
    );
  } else if (sessionBanner) {
    banner = (
      <div
        className="flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-2"
        role="alert"
      >
        <p className="type-meta text-[var(--text)]">
          Session expired. Sign in again to continue.
        </p>
        <Link
          href="/sign-in"
          className="ds-btn ds-btn-primary ds-btn-sm shrink-0"
        >
          Sign in
        </Link>
      </div>
    );
  } else if (serverBanner) {
    banner = (
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
  } else if (syncBanner) {
    banner = (
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
  } else if (emptyBanner) {
    banner = (
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

  return (
    <>
      {/* Stable mark — remounting per branch cleared the attr for a tick. */}
      <ChromeBannerMark active={showChromeBanner} />
      {banner}
    </>
  );
}

/** Full-page gate while Clerk + org bootstrap. */
export function PortalBootGate({ children }: { children: ReactNode }) {
  const { loading: authLoading } = useAuth();
  const { loading: orgLoading, currentOrg, organizations, authError } =
    useOrg();
  const { isLoaded: clerkLoaded, isSignedIn } = useClerkAuth();
  const queryClient = useQueryClient();
  // Layout SSR dehydrates ``["auth","me"]`` above this gate. If that
  // cache is warm, do not block page paint on local org state catch-up.
  const hasCachedMe = Boolean(queryClient.getQueryData(["auth", "me"]));

  if (
    !clerkLoaded ||
    (isSignedIn &&
      (authLoading || orgLoading) &&
      !currentOrg &&
      !authError &&
      organizations.length === 0 &&
      !hasCachedMe)
  ) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--bg)]">
        <p className="type-meta text-[var(--text-faint)]">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
}
