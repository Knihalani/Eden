import { HydrationBoundary } from "@tanstack/react-query";
import { dehydrateIssues } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import IssuesClient from "./issues-client";

/** SSR wrapper for ``/issues`` — warms agents + issues. */
export default async function IssuesPage() {
  const auth = await resolvePortalPrefetchAuth();
  if (!auth?.orgId) {
    return <IssuesClient />;
  }
  try {
    const dehydratedState = await dehydrateIssues(auth);
    return (
      <HydrationBoundary state={dehydratedState}>
        <IssuesClient />
      </HydrationBoundary>
    );
  } catch {
    return <IssuesClient />;
  }
}
