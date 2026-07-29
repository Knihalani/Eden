import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateAgents } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import AgentsClient from "./agents-client";

/** SSR wrapper for ``/agents`` — warms agents + traces + sessions. */
export default async function AgentsPage() {
  const auth = await resolvePortalPrefetchAuth();
  // JSX must be constructed outside the try/catch (react-hooks/error-boundaries):
  // rendering happens after this function returns, so a try/catch around the
  // JSX would never catch a render error anyway. Only the await is guarded.
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateAgents(auth);
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
