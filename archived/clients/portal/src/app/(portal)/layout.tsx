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
 *
 * The seed is bounded: Clerk JWT minting + the server-to-server
 * ``/auth/me`` round-trip sit on the TTFB critical path, and a slow
 * backend must not stall the first byte indefinitely. Past the budget
 * we render without the seed and BootGate fetches ``/auth/me``
 * client-side (the in-flight promise is React.cache'd, so a page-level
 * dehydrate in the same request can still await it to completion).
 */
const PREFETCH_BUDGET_MS = 700;

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const auth = await Promise.race([
    resolvePortalPrefetchAuth(),
    new Promise<null>((resolve) => {
      budgetTimer = setTimeout(() => resolve(null), PREFETCH_BUDGET_MS);
    }),
  ]);
  clearTimeout(budgetTimer);
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
