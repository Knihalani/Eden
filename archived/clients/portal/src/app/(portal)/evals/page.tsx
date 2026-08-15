import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateEvals } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import EvalsClient from "./evals-client";

export const metadata = {
  title: "Evals · Eden",
  description: "Evaluation hub — datasets, playgrounds, and experiments.",
};

/** Cap SSR shard wait; return whatever settled (partial dehydrate). */
const EVALS_DEHYDRATE_BUDGET_MS = 1500;

/**
 * RSC wrapper for ``/evals`` — warms agents + datasets + playgrounds +
 * experiments shards so the evals hub renders from cache instead of
 * four cold client waterfalls on mount.
 */
export default async function EvalsPage() {
  const auth = await resolvePortalPrefetchAuth();
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateEvals(auth, EVALS_DEHYDRATE_BUDGET_MS);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <EvalsClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <EvalsClient />
    </HydrationBoundary>
  );
}
