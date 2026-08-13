import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydratePrompts } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import PromptsClient from "./prompts-client";

export const metadata = {
  title: "Prompts · Eden",
  description: "Prompt registry — versions, environment pins, and A/B deploy.",
};

/** Cap SSR shard wait; return whatever settled (partial dehydrate). */
const PROMPTS_DEHYDRATE_BUDGET_MS = 1500;

/**
 * RSC wrapper for ``/prompts`` — warms the prompt list shard so the
 * sidebar renders from cache instead of a cold client fetch.
 *
 * ``detail`` and ``pins`` depend on the selected prompt URL param and
 * are intentionally left to the client to fetch after hydration.
 */
export default async function PromptsPage() {
  const auth = await resolvePortalPrefetchAuth();
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydratePrompts(auth, PROMPTS_DEHYDRATE_BUDGET_MS);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <PromptsClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <PromptsClient />
    </HydrationBoundary>
  );
}
