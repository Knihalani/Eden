import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateIssues } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import IssuesClient from "./issues-client";

/** SSR wrapper for ``/issues`` — warms agents + issues. */
export default async function IssuesPage() {
  const auth = await resolvePortalPrefetchAuth();
  // JSX must be constructed outside the try/catch (react-hooks/error-boundaries):
  // rendering happens after this function returns, so a try/catch around the
  // JSX would never catch a render error anyway. Only the await is guarded.
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateIssues(auth);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <IssuesClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <IssuesClient />
    </HydrationBoundary>
  );
}
