"use client";

/**
 * Improve plan detail enrichment — Evidence, derived status history, and
 * the change-impact preview. Rendered by improve/page.tsx below
 * ImprovePlanView when a plan is selected.
 *
 * Fetches the raw plan record (``GET /orgs/{org}/improve/plans/{id}``)
 * for the full ``evidence`` payload; local draft plans (deep-link
 * synthesized) skip the fetch and render from fixture fields only.
 */

import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey } from "@/lib/query-keys";
import { improvePlansApi } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";
import { PlanEvidencePanel } from "./plan-evidence-panel";
import { PlanStatusHistory } from "./plan-status-history";
import { PlanEventLog } from "./plan-event-log";
import { PlanImpactPreview } from "./plan-impact-preview";

export function PlanDetailEnrichment({
  orgId,
  plan,
  isDraft,
}: {
  orgId: string | null;
  plan: ImprovePlanFixture;
  isDraft: boolean;
}) {
  const rawQuery = useOrgQuery(
    queryKey("improvePlanDetail", orgId, plan.id),
    orgId,
    () => improvePlansApi.getPlan(orgId!, plan.id),
    {
      ...SHELL_QUERY,
      enabled: Boolean(orgId) && !isDraft,
    },
  );
  const raw = isDraft ? null : (rawQuery.data?.data?.plan ?? null);

  return (
    <div className="space-y-3 border-t border-[var(--line)] px-4 py-4 sm:px-6">
      <PlanEvidencePanel plan={plan} raw={raw} />
      <PlanStatusHistory plan={plan} raw={raw} />
      <PlanEventLog orgId={orgId} planId={plan.id} isDraft={isDraft} />
      <PlanImpactPreview
        orgId={orgId}
        plan={plan}
        raw={raw}
        isDraft={isDraft}
      />
    </div>
  );
}
