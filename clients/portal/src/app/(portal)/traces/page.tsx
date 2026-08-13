import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateTraces } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import { DemoBanner } from "@/components/onboarding/DemoBanner";
import TracesClient from "./traces-client";

export const metadata = {
  title: "Traces · Eden",
  description: "Inspect every agent run — spans, tool calls, and outcomes.",
};

/** Cap SSR shard wait; return whatever settled (partial dehydrate). */
const TRACES_DEHYDRATE_BUDGET_MS = 1800;

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
      dehydratedState = await dehydrateTraces(auth, TRACES_DEHYDRATE_BUDGET_MS);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return (
      <>
        <DemoBanner />
        <TracesClient />
      </>
    );
  }
  return (
    <>
      <DemoBanner />
      <HydrationBoundary state={dehydratedState}>
        <TracesClient />
      </HydrationBoundary>
    </>
  );
}
