"use client";

import { useAuth } from "@/hooks/use-auth";
import { useOnline } from "@/hooks/use-online";
import { useOrg } from "@/hooks/use-org";
import { useSidebarPrefs, applySidebarPrefs } from "@/hooks/use-sidebar-prefs";
import {
  usePortalChromeAuthGate,
  usePortalChromeBannerAttr,
  usePortalChromeCollapse,
  usePortalChromeMobileDrawerTrap,
  usePortalChromeNarrowViewport,
  usePortalChromeShortcuts,
  usePortalChromeTour,
} from "@/hooks/use-portal-chrome-effects";
import { useClerk } from "@clerk/nextjs";
import { api } from "@/lib/api/auth-client";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState, useRef, useCallback, Suspense } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/portal-os/AppShell";
import { MobileBottomNav } from "@/components/portal-os/MobileBottomNav";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { isKnownPortalPath } from "@/lib/portal-routes";
import { buildBreadcrumbs } from "@/lib/breadcrumbs";
import {
  SidebarNav,
  PortalHeader,
  ChromeBanners,
  AiRailHost,
  SIDEBAR_EXPANDED_WIDTH,
  shouldCollapseOnboardingBanner,
} from "@/components/portal-chrome";

const CommandPalette = dynamic(
  () =>
    import("@/components/portal-os/CommandPalette").then((m) => ({
      default: m.CommandPalette,
    })),
  { ssr: false },
);
const OnboardingOverlay = dynamic(
  () =>
    import("@/components/onboarding/OnboardingOverlay").then((m) => ({
      default: m.OnboardingOverlay,
    })),
  { ssr: false },
);
const OnboardingBanner = dynamic(
  () =>
    import("@/components/onboarding-banner").then((m) => ({
      default: m.OnboardingBanner,
    })),
  { ssr: false },
);

async function handleLogout(
  router: ReturnType<typeof useRouter>,
  closeDropdown: () => void,
  signOut: () => Promise<void>,
) {
  closeDropdown();
  await Promise.allSettled([
    signOut(),
    api.logout().catch((err) => {
      if (process.env.NODE_ENV !== "production") {
        console.warn("Backend logout failed (continuing):", err);
      }
    }),
  ]);
  router.push("/sign-in");
}

/** Client chrome island — auth gate, sidebar, header, lazy islands. Wave 11.10 ≤400. */
export function PortalChrome({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div
          className="min-h-[100dvh] bg-[var(--bg-secondary)] flex flex-col items-center justify-center gap-3"
          aria-busy="true"
          aria-label="Loading portal"
        >
          <div className="h-px w-16 bg-[var(--border-default)]" />
          <p className="text-2xs font-mono uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Loading
          </p>
        </div>
      }
    >
      <PortalLayoutContent>{children}</PortalLayoutContent>
    </Suspense>
  );
}

function PortalLayoutContent({ children }: { children: React.ReactNode }) {
  const { user, loading, refreshUserWithRetry } = useAuth();
  const online = useOnline();
  const { signOut } = useClerk();
  const { prefs, togglePin } = useSidebarPrefs();
  const {
    authError,
    authErrorKind,
    clearAuthError,
    refreshOrgs,
    currentOrg,
    orgSyncing,
    loading: orgLoading,
  } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const {
    collapsed,
    setCollapsed,
    advancedCollapsed,
    setAdvancedCollapsed,
    toggleAdvanced,
    handleCollapse,
  } = usePortalChromeCollapse();
  const densityCompact = prefs.density === "compact";
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteEverOpened, setPaletteEverOpened] = useState(false);
  useEffect(() => {
    if (commandPaletteOpen) setPaletteEverOpened(true);
  }, [commandPaletteOpen]);
  const userDropdownRef = useRef<HTMLDivElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarAsideRef = useRef<HTMLElement>(null);
  const isNarrowViewport = usePortalChromeNarrowViewport();

  const closeMobileDrawer = useCallback(() => {
    setSidebarOpen(false);
    if (!isNarrowViewport) return;
    requestAnimationFrame(() => {
      menuButtonRef.current?.focus();
    });
  }, [isNarrowViewport]);

  useEffect(() => {
    if (!userDropdownOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const root = userDropdownRef.current;
      if (root && !root.contains(event.target as Node)) {
        setUserDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [userDropdownOpen]);

  const tourSpotlightActive = usePortalChromeTour({
    setCollapsed,
    setAdvancedCollapsed,
    setSidebarOpen,
  });

  usePortalChromeShortcuts({
    sidebarOpen,
    closeMobileDrawer,
    setCollapsed,
    setCommandPaletteOpen,
  });

  const mobileDrawerOpen = isNarrowViewport && sidebarOpen;

  usePortalChromeMobileDrawerTrap({
    mobileDrawerOpen,
    sidebarAsideRef,
    sidebarCloseRef,
  });

  usePortalChromeAuthGate({
    user,
    loading,
    orgLoading,
    currentOrg,
    orgSyncing,
    authErrorKind,
    userOrgCount: user?.organizations?.length ?? 0,
  });

  const showAuthBanner = !!(!loading && user && authError);
  const isSessionAuthError = authErrorKind === "session";
  const showOrgSyncingBanner = !!(
    !loading &&
    user &&
    orgSyncing &&
    authErrorKind !== "session"
  );
  const blockingChromeBanner = !!(
    showAuthBanner ||
    showOrgSyncingBanner ||
    !online
  );

  usePortalChromeBannerAttr(blockingChromeBanner);

  if (loading && !isKnownPortalPath(pathname)) {
    return <>{children}</>;
  }
  if (loading) {
    return (
      <div
        className="min-h-screen flex flex-col lg:flex-row bg-[var(--bg-secondary)]"
        aria-busy="true"
        aria-live="polite"
        aria-label="Loading portal"
      >
        <aside
          className="sidebar hidden lg:flex flex-col bg-[var(--bg-primary)] border-r border-[var(--border-default)] z-50 h-full"
          style={{ width: SIDEBAR_EXPANDED_WIDTH }}
          aria-hidden="true"
        />
        <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3">
          <Loader2
            className="h-5 w-5 animate-spin text-[var(--text-muted)]"
            aria-hidden
          />
          <p className="text-sm text-[var(--text-muted)]">Signing you in</p>
        </main>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const breadcrumbs = buildBreadcrumbs(pathname);
  const { pinnedItems, groups } = applySidebarPrefs(prefs, advancedCollapsed);

  return (
    <AppShell
      density={densityCompact ? "compact" : "comfortable"}
      sidebar={
        <SidebarNav
          collapsed={collapsed}
          sidebarOpen={sidebarOpen}
          mobileDrawerOpen={mobileDrawerOpen}
          advancedCollapsed={advancedCollapsed}
          densityCompact={densityCompact}
          tourSpotlightActive={tourSpotlightActive}
          pinnedItems={pinnedItems}
          groups={groups}
          prefsPinned={prefs.pinned}
          onTogglePin={togglePin}
          onToggleAdvanced={toggleAdvanced}
          onCollapse={handleCollapse}
          onCloseMobileDrawer={closeMobileDrawer}
          user={{ name: user.name, email: user.email }}
          userDropdownOpen={userDropdownOpen}
          setUserDropdownOpen={setUserDropdownOpen}
          userDropdownRef={userDropdownRef}
          sidebarCloseRef={sidebarCloseRef}
          sidebarAsideRef={sidebarAsideRef}
          onLogout={() =>
            void handleLogout(router, () => setUserDropdownOpen(false), signOut)
          }
        />
      }
      header={
        <PortalHeader
          breadcrumbs={breadcrumbs}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          menuButtonRef={menuButtonRef}
        />
      }
      mobileNav={<MobileBottomNav />}
      commandPalette={
        commandPaletteOpen || paletteEverOpened ? (
          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
          />
        ) : null
      }
      aiRail={<AiRailHost suppressCoach={!!showAuthBanner} />}
    >
      <div className="page-enter flex flex-col">
        <OnboardingBanner
          collapsed={shouldCollapseOnboardingBanner(showAuthBanner)}
        />
        <Suspense fallback={null}>
          <OnboardingOverlay />
        </Suspense>
        <ErrorBoundary
          fallback={
            <div className="flex-1 flex items-center justify-center p-8 text-center">
              <div className="max-w-md space-y-3">
                <p className="text-sm text-[var(--text-secondary)]">
                  This page hit an unexpected error. The rest of the portal is
                  still usable — try a different section from the sidebar, or
                  reload the page.
                </p>
              </div>
            </div>
          }
        >
          <ChromeBanners
            online={online}
            showAuthBanner={showAuthBanner}
            isSessionAuthError={isSessionAuthError}
            authError={authError}
            showOrgSyncingBanner={showOrgSyncingBanner}
            clearAuthError={clearAuthError}
            refreshUserWithRetry={refreshUserWithRetry}
            refreshOrgs={refreshOrgs}
            onSignIn={() => router.push("/sign-in")}
          />
          {children}
        </ErrorBoundary>
      </div>
    </AppShell>
  );
}
