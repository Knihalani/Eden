/**
 * Portal route-group layout — AppShell + density (Phase 1–7 rebuild).
 */

import { PortalProviders } from "./providers";
import { DensityProvider } from "@/components/shell/density-provider";
import { AppShell } from "@/components/shell/app-shell";

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PortalProviders>
      <DensityProvider>
        <AppShell>{children}</AppShell>
      </DensityProvider>
    </PortalProviders>
  );
}
