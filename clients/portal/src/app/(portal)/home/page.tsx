import { HydrationBoundary } from "@tanstack/react-query";
import { dehydrateHome } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import HomeClient from "./home-client";

/**
 * SSR wrapper for ``/home`` — prefetches ``/auth/me`` + portal agents /
 * traces / issues so first paint does not wait on cold client GETs.
 */
export default async function HomePage() {
  const auth = await resolvePortalPrefetchAuth();
  if (!auth?.orgId) {
    return <HomeClient />;
  }
  try {
    const dehydratedState = await dehydrateHome(auth);
    return (
      <HydrationBoundary state={dehydratedState}>
        <HomeClient />
      </HydrationBoundary>
    );
  } catch {
    return <HomeClient />;
  }
}
