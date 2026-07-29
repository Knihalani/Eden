import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateTraces } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import TracesClient from "./traces-client";

/**
 * SSR wrapper for ``/traces`` — warms agents + traces + sessions so the
 * hub list paints from cache instead of three cold client GETs.
 */
export default async function TracesPage() {
  const auth = await resolvePortalPrefetchAuth();
  // JSX must be constructed outside the try/catch (react-hooks/error-boundaries):
  // rendering happens after this function returns, so a try/catch around the
  // JSX would never catch a render error anyway. Only the await is guarded.
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateTraces(auth);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <TracesClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <TracesClient />
    </HydrationBoundary>
  );
}
