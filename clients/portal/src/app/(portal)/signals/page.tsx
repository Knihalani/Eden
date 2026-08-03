import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateSignals } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import SignalsClient from "./signals-client";

/** Cap SSR shard wait; return whatever settled (partial dehydrate). */
const SIGNALS_DEHYDRATE_BUDGET_MS = 1500;

/** SSR wrapper for ``/signals`` — warms agents + signals. */
export default async function SignalsPage() {
  const auth = await resolvePortalPrefetchAuth();
  // JSX must be constructed outside the try/catch (react-hooks/error-boundaries):
  // rendering happens after this function returns, so a try/catch around the
  // JSX would never catch a render error anyway. Only the await is guarded.
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateSignals(auth, SIGNALS_DEHYDRATE_BUDGET_MS);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <SignalsClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <SignalsClient />
    </HydrationBoundary>
  );
}
