"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import { SidebarNav } from "./sidebar-nav";
import { MobileBottomNav } from "./mobile-nav";
import { SidebarProvider } from "./sidebar-context";
import { AlertsProvider } from "@/lab/alerts-context";
import { LabToastProvider } from "@/lab/lab-toast";
import { SignalJobsProvider } from "@/lab/signal-jobs-context";
import {
  PortalBootGate,
  PortalStatusBanners,
} from "@/components/shell/portal-auth-chrome";
import { PortalCatalogSync } from "@/components/providers/portal-catalog-sync";
import { OnboardingBanner } from "@/components/onboarding/OnboardingBanner";
import { ConfirmProvider } from "@/hooks/use-confirm";

/** Alerts modal pulls heavy graphs — load after first paint. */
const AlertsModal = dynamic(
  () =>
    import("@/lab/alerts-panel").then((m) => ({ default: m.AlertsModal })),
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

function CatalogSyncFallback() {
  return (
    <span className="sr-only" role="status">
      Syncing catalog…
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <ConfirmProvider>
        <LabToastProvider>
          <AlertsProvider>
            <SignalJobsProvider>
              <Suspense fallback={<CatalogSyncFallback />}>
                <PortalCatalogSync />
              </Suspense>
              <div className="flex h-dvh overflow-hidden bg-[var(--bg)] text-[var(--text)]" data-eden-portal-shell>
                <SidebarNav />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]">
                  <PortalStatusBanners />
                  <OnboardingBanner />
                  <main className="min-h-0 flex-1 overflow-auto outline-none pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
                    <PortalBootGate>{children}</PortalBootGate>
                  </main>
                </div>
                <MobileBottomNav />
              </div>
              <AlertsModal />
              <OnboardingOverlay />
            </SignalJobsProvider>
          </AlertsProvider>
        </LabToastProvider>
      </ConfirmProvider>
    </SidebarProvider>
  );
}
