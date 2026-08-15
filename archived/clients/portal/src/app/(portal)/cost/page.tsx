import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateCost } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import CostClient from "./cost-client";

export const metadata = {
  title: "Cost · Eden",
  description: "Spend analytics — cost drivers, budget, and sampling stats.",
};

/** Cap SSR shard wait; return whatever settled (partial dehydrate). */
const COST_DEHYDRATE_BUDGET_MS = 1500;

/**
 * RSC wrapper for ``/cost`` — warms agents + cost drivers + budget +
 * traces + sampling-stats shards so the spend dashboard renders from
 * cache instead of five cold client waterfalls on mount.
 *
 * The budget key ``["cost", orgId, "budget"]`` matches the
 * ``BUDGET_QUERY_KEY`` constant in ``cost-client.tsx`` exactly.
 */
export default async function CostPage() {
  const auth = await resolvePortalPrefetchAuth();
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateCost(auth, COST_DEHYDRATE_BUDGET_MS);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <CostClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <CostClient />
    </HydrationBoundary>
  );
}
