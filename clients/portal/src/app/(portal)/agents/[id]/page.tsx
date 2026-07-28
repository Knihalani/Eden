import { redirect } from "next/navigation";

/**
 * `/agents/<id>` → `/agents?id=<id>`.
 *
 * Agent detail is a selection within the fleet list, not a separate page —
 * `agents-client.tsx` reads the agent from `?id=`. But `/agents/<id>` was
 * still being produced in three places, and none of them had a page to
 * land on:
 *
 *   - `lib/agent-health.ts` builds it as the click target for the Home
 *     attention items, which is on the first-run path;
 *   - `lib/citation-href.ts` builds it for assistant citations;
 *   - `next.config.ts` redirects six legacy paths (`/agents/:id/drift`,
 *     `/sim-runs`, `/test-runs`, …) here.
 *
 * All of those resolved to the global catch-all and rendered a hard 404.
 * Translating the path form into the query form fixes every caller at once
 * and keeps the old URLs working.
 */
export default async function AgentDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/agents?id=${encodeURIComponent(id)}`);
}
