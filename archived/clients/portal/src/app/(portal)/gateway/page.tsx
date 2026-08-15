import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateGateway } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import GatewayClient from "./gateway-client";

export const metadata = {
  title: "Gateway · Eden",
  description: "LLM gateway metrics — spend, cache hit rate, and model mix.",
};

/** Cap SSR shard wait; return whatever settled (partial dehydrate). */
const GATEWAY_DEHYDRATE_BUDGET_MS = 1500;

/**
 * RSC wrapper for ``/gateway`` — warms the 24-hour overview shard so
 * the spend chart paints from cache instead of a cold client fetch.
 *
 * Replaces the old ``"use client"`` + ``dynamic`` pattern; recharts is
 * still code-split automatically by Next.js (client boundary in
 * ``gateway-client.tsx``).
 */
export default async function GatewayPage() {
  const auth = await resolvePortalPrefetchAuth();
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateGateway(auth, GATEWAY_DEHYDRATE_BUDGET_MS);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <GatewayClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <GatewayClient />
    </HydrationBoundary>
  );
}
