import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { dehydrateSettings } from "@/lib/portal-dehydrate";
import { resolvePortalPrefetchAuth } from "@/lib/portal-ssr";
import SettingsClient from "./settings-client";

export const metadata = {
  title: "Settings · Eden",
  description: "Workspace settings — API keys, members, and audit log.",
};

/** Cap SSR shard wait; return whatever settled (partial dehydrate). */
const SETTINGS_DEHYDRATE_BUDGET_MS = 1500;

/**
 * RSC wrapper for ``/settings`` — warms workspace + keys + members +
 * audit log shards so the settings panel renders from cache instead of
 * five cold client waterfalls.
 */
export default async function SettingsPage() {
  const auth = await resolvePortalPrefetchAuth();
  let dehydratedState: DehydratedState | null = null;
  if (auth?.orgId) {
    try {
      dehydratedState = await dehydrateSettings(auth, SETTINGS_DEHYDRATE_BUDGET_MS);
    } catch {
      dehydratedState = null; // prefetch is an optimisation — fall back to client fetch
    }
  }
  if (!dehydratedState) {
    return <SettingsClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <SettingsClient />
    </HydrationBoundary>
  );
}
