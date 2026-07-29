import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateHome } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import HomeClient from "./home-client";

/**
 * SSR wrapper for ``/home`` — prefetches ``/auth/me`` + portal agents /
 * traces / issues so first paint does not wait on cold client GETs.
 */
export default async function HomePage() {
  const auth = await resolvePortalPrefetchAuth();
  // JSX must be constructed outside the try/catch (react-hooks/error-boundaries):
  // rendering happens after this function returns, so a try/catch around the
  // JSX would never catch a render error anyway. Only the await is guarded.
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateHome(auth);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <HomeClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <HomeClient />
    </HydrationBoundary>
  );
}
