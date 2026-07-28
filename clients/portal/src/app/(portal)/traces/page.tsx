import { HydrationBoundary } from "@tanstack/react-query";
import { dehydrateTraces } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import TracesClient from "./traces-client";

/**
 * SSR wrapper for ``/traces`` — warms agents + traces + sessions so the
 * hub list paints from cache instead of three cold client GETs.
 */
export default async function TracesPage() {
  const auth = await resolvePortalPrefetchAuth();
  if (!auth?.orgId) {
    return <TracesClient />;
  }
  try {
    const dehydratedState = await dehydrateTraces(auth);
    return (
      <HydrationBoundary state={dehydratedState}>
        <TracesClient />
      </HydrationBoundary>
    );
  } catch {
    return <TracesClient />;
  }
}
