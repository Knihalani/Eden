import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateHome } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import HomeClient from "./home-client";

/** Cap SSR shard wait so document load isn't blocked ~3s on cold traces/issues. */
const HOME_DEHYDRATE_BUDGET_MS = 800;

/**
 * SSR wrapper for ``/home`` — warms ``/auth/me`` + portal traces /
 * issues when they settle within the budget; otherwise falls through
 * to client fetch so HTML can flush quickly.
 */
export default async function HomePage() {
  const auth = await resolvePortalPrefetchAuth();
  // JSX must be constructed outside the try/catch (react-hooks/error-boundaries):
  // rendering happens after this function returns, so a try/catch around the
  // JSX would never catch a render error anyway. Only the await is guarded.
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await Promise.race([
        dehydrateHome(auth),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), HOME_DEHYDRATE_BUDGET_MS);
        }),
      ]);
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
