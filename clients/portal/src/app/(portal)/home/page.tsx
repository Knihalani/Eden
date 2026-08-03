import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateHome } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import HomeClient from "./home-client";

/** Cap SSR shard wait; return whatever settled (partial dehydrate). */
const HOME_DEHYDRATE_BUDGET_MS = 1500;

/**
 * SSR wrapper for ``/home`` — warms portal traces / issues when they
 * settle within the budget; otherwise falls through to client fetch so
 * HTML can flush quickly. ``/auth/me`` is seeded by layout ``dehydrateMe``.
 */
export default async function HomePage() {
  const auth = await resolvePortalPrefetchAuth();
  // JSX must be constructed outside the try/catch (react-hooks/error-boundaries):
  // rendering happens after this function returns, so a try/catch around the
  // JSX would never catch a render error anyway. Only the await is guarded.
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      // Partial dehydrate: shards that finish within the budget are kept;
      // do not race the whole promise to null (that discarded warm work).
      dehydratedState = await dehydrateHome(auth, HOME_DEHYDRATE_BUDGET_MS);
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
