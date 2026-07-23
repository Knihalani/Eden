import { AppShell } from "@/components/shell/app-shell";
import { PortalProviders } from "@/components/providers/portal-providers";

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PortalProviders>
      <AppShell>{children}</AppShell>
    </PortalProviders>
  );
}
