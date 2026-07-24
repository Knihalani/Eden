"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import { SidebarNav } from "./sidebar-nav";
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
import { OnboardingOverlay } from "@/components/onboarding/OnboardingOverlay";

/** Alerts modal pulls heavy graphs — load after first paint. */
const AlertsModal = dynamic(
  () =>
    import("@/lab/alerts-panel").then((m) => ({ default: m.AlertsModal })),
  { ssr: false },
);

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <LabToastProvider>
        <AlertsProvider>
          <SignalJobsProvider>
            <Suspense fallback={null}>
              <PortalCatalogSync />
            </Suspense>
            <div className="flex h-dvh overflow-hidden bg-[var(--bg)] text-[var(--text)]" data-eden-portal-shell>
              <SidebarNav />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]">
                <PortalStatusBanners />
                <OnboardingBanner />
                <main className="min-h-0 flex-1 overflow-auto outline-none">
                  <PortalBootGate>{children}</PortalBootGate>
                </main>
              </div>
            </div>
            <AlertsModal />
            <OnboardingOverlay />
          </SignalJobsProvider>
        </AlertsProvider>
      </LabToastProvider>
    </SidebarProvider>
  );
}
