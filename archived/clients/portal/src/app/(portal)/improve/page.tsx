import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateImprove } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import ImproveClient from "./improve-client";

export const metadata = {
  title: "Improve · Eden",
  description: "Actionable improvement plans from your agents.",
};

/** OOM P6: cap SSR shard wait; partial dehydrate wins over full timeout. */
const IMPROVE_DEHYDRATE_BUDGET_MS = 1500;

/**
 * RSC wrapper for ``/improve`` — warms agents + plans (first page) + queue.
 *
 * OOM P6: eliminates the 4+ mount-time waterfalls the pure client page
 * previously fired. Uses ``HydrationBoundary`` exactly as home/issues do.
 */
export default async function ImprovePage() {
  const auth = await resolvePortalPrefetchAuth();
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateImprove(auth, IMPROVE_DEHYDRATE_BUDGET_MS);
    } catch {
      // Prefetch is an optimisation — fall back to cold client fetch on error.
      dehydratedState = null;
    }
  }
  if (!dehydratedState) {
    return <ImproveClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <ImproveClient />
    </HydrationBoundary>
  );
}
