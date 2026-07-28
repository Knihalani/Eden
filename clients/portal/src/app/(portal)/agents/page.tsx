import { HydrationBoundary } from "@tanstack/react-query";
import { dehydrateAgents } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import AgentsClient from "./agents-client";

/** SSR wrapper for ``/agents`` — warms agents + traces + sessions. */
export default async function AgentsPage() {
  const auth = await resolvePortalPrefetchAuth();
  if (!auth?.orgId) {
    return <AgentsClient />;
  }
  try {
    const dehydratedState = await dehydrateAgents(auth);
    return (
      <HydrationBoundary state={dehydratedState}>
        <AgentsClient />
      </HydrationBoundary>
    );
  } catch {
    return <AgentsClient />;
  }
}
