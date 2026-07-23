import { AppShell } from "@/components/shell/app-shell";
import { AppClerkProvider } from "@/components/providers/app-clerk-provider";
import { PortalProviders } from "@/components/providers/portal-providers";

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppClerkProvider>
      <PortalProviders>
        <AppShell>{children}</AppShell>
      </PortalProviders>
    </AppClerkProvider>
  );
}
