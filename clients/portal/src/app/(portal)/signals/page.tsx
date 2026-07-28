import { HydrationBoundary } from "@tanstack/react-query";
import { dehydrateSignals } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import SignalsClient from "./signals-client";

/** SSR wrapper for ``/signals`` — warms agents + signals + alert rules. */
export default async function SignalsPage() {
  const auth = await resolvePortalPrefetchAuth();
  if (!auth?.orgId) {
    return <SignalsClient />;
  }
  try {
    const dehydratedState = await dehydrateSignals(auth);
    return (
      <HydrationBoundary state={dehydratedState}>
        <SignalsClient />
      </HydrationBoundary>
    );
  } catch {
    return <SignalsClient />;
  }
}
