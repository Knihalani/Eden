"use client";

import dynamic from "next/dynamic";
import { Suspense, useRef } from "react";
import { usePathname } from "next/navigation";
import { SidebarNav } from "./sidebar-nav";
import { MobileBottomNav } from "./mobile-nav";
import { SidebarProvider } from "./sidebar-context";
import { AlertsProvider } from "@/lab/alerts-context";
import { LabToastProvider } from "@/lab/lab-toast";
import { NotificationsProvider } from "@/hooks/use-notifications";
import {
  PortalBootGate,
  PortalStatusBanners,
} from "@/components/shell/portal-auth-chrome";
import { PortalCatalogSync } from "@/components/providers/portal-catalog-sync";
import { useTourProgress } from "@/hooks/use-tour-progress";
import { ConfirmProvider } from "@/hooks/use-confirm";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { openCommandPalette } from "@/lib/palette";
import { useRouteScrollReset } from "@/hooks/use-route-scroll-reset";
import { Search } from "lucide-react";

/** Alerts modal pulls heavy graphs — load after first paint. */
const AlertsModal = dynamic(
  () =>
    import("@/lab/alerts-panel").then((m) => ({ default: m.AlertsModal })),
  { ssr: false },
);

/** Onboarding banner — only needed while the personal tour is incomplete.
 *  Lazy-loaded so the chunk is not in the initial bundle for users whose
 *  tour is already done (P8). */
const OnboardingBanner = dynamic(
  () =>
    import("@/components/onboarding/OnboardingBanner").then((m) => ({
      default: m.OnboardingBanner,
    })),
  { ssr: false },
);

/** Tour / overlay — defer until after shell paint. */
const OnboardingOverlay = dynamic(
  () =>
    import("@/components/onboarding/OnboardingOverlay").then((m) => ({
      default: m.OnboardingOverlay,
    })),
  { ssr: false },
);

/** ⌘K palette — bind after hydration; dialog mounts when opened. */
const CommandPalette = dynamic(
  () =>
    import("@/components/shell/command-palette").then((m) => ({
      default: m.CommandPalette,
    })),
  { ssr: false },
);

function CatalogSyncFallback() {
  return (
    <span className="sr-only" role="status">
      Syncing catalog…
    </span>
  );
}

/**
 * Route-fade wrapper. Keyed on ``pathname`` (not search params) so a page
 * change re-mounts the wrapper and replays the entrance animation, while
 * ``?id=`` / ``?view=`` tweaks inside a page keep the wrapper (and the
 * user's scroll position) untouched.
 */
function RouteFade({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  return (
    <div key={pathname} className="eden-route-fade flex h-full min-h-0 flex-col">
      {children}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const mainRef = useRef<HTMLElement | null>(null);
  useRouteScrollReset(mainRef);
  // Gate banner rendering so the lazy chunk is never requested for
  // users whose tour is already complete (P8). Defaults to true while
  // Clerk hasn't loaded yet (progress is null → shouldShowTourBanner
  // returns true), so it stays conservative on first render.
  const { showBanner } = useTourProgress();

  return (
    <SidebarProvider>
      <ConfirmProvider>
        <LabToastProvider>
          <NotificationsProvider>
            <AlertsProvider>
              <div className="flex h-dvh overflow-hidden bg-[var(--bg)] text-[var(--text)]" data-eden-portal-shell>
                <SidebarNav />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]">
                  <div className="flex h-[var(--header-h)] shrink-0 items-center justify-end gap-1 border-b border-[var(--line)] bg-[var(--bg-sidebar)] px-2 md:hidden">
                    <button
                      type="button"
                      onClick={openCommandPalette}
                      className="ds-btn ds-btn-ghost ds-btn-icon"
                      title="Search (⌘K)"
                      aria-label="Search (⌘K)"
                    >
                      <Search className="h-4 w-4" aria-hidden />
                    </button>
                    <NotificationsBell />
                  </div>
                  <PortalStatusBanners />
                  {showBanner ? <OnboardingBanner /> : null}
                  <main
                    ref={mainRef}
                    id="eden-main-content"
                    tabIndex={-1}
                    className="min-h-0 flex-1 overflow-auto outline-none pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0"
                  >
                    {/*
                      CatalogSync must sit *inside* BootGate and *after*
                      page children so HydrationBoundary can seed the
                      cache before CatalogSync's useOrgQuery observers
                      subscribe. Outside BootGate it raced dehydrate and
                      started duplicate client GETs on cold Home.
                    */}
                    <PortalBootGate>
                      <RouteFade>
                        {children}
                        <Suspense fallback={<CatalogSyncFallback />}>
                          <PortalCatalogSync />
                        </Suspense>
                      </RouteFade>
                    </PortalBootGate>
                  </main>
                </div>
                <MobileBottomNav />
              </div>
              <AlertsModal />
              <OnboardingOverlay />
              <CommandPalette />
            </AlertsProvider>
          </NotificationsProvider>
        </LabToastProvider>
      </ConfirmProvider>
    </SidebarProvider>
  );
}
