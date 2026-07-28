import { HydrationBoundary } from "@tanstack/react-query";
import { AppShell } from "@/components/shell/app-shell";
import { AppClerkProvider } from "@/components/providers/app-clerk-provider";
import { PortalProviders } from "@/components/providers/portal-providers";
import { dehydrateMe } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";

/**
 * Portal chrome. SSR-seeds ``["auth","me"]`` above AppShell / BootGate
 * so Clerk + React Query hydrate from warm cache instead of blocking
 * the first paint on a cold client ``/auth/me``.
 */
export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await resolvePortalPrefetchAuth();
  const meState = auth ? await dehydrateMe(auth) : null;

  return (
    <AppClerkProvider>
      <PortalProviders>
        {meState ? (
          <HydrationBoundary state={meState}>
            <AppShell>{children}</AppShell>
          </HydrationBoundary>
        ) : (
          <AppShell>{children}</AppShell>
        )}
      </PortalProviders>
    </AppClerkProvider>
  );
}
