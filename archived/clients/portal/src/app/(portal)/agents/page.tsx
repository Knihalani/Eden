import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateAgents } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import AgentsClient from "./agents-client";

export const metadata = {
  title: "Agents · Eden",
  description: "Your agent fleet — health, versions, and traffic.",
};

/** Cap SSR shard wait; return whatever settled (partial dehydrate). */
const AGENTS_DEHYDRATE_BUDGET_MS = 1500;

/** SSR wrapper for ``/agents`` — warms agents + traces. */
export default async function AgentsPage() {
  const auth = await resolvePortalPrefetchAuth();
  // JSX must be constructed outside the try/catch (react-hooks/error-boundaries):
  // rendering happens after this function returns, so a try/catch around the
  // JSX would never catch a render error anyway. Only the await is guarded.
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateAgents(auth, AGENTS_DEHYDRATE_BUDGET_MS);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <AgentsClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <AgentsClient />
    </HydrationBoundary>
  );
}
