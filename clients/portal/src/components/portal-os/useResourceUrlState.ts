"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  MASTER_DETAIL_QUERY_KEYS,
  readMasterDetailParam,
  writeMasterDetailParam,
} from "./CoreResourcePage";

export type ResourceUrlState = {
  /** Hub lens tab: traces | spans | sessions (not a saved view id). */
  view?: string;
  q?: string;
  filter?: string;
  /** Canonical detail id — aliases trace_id / trace are normalized on write. */
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  pastHours?: string;
  issueId?: string;
  alertId?: string;
  agentId?: string;
  experimentId?: string;
  promotionId?: string;
  artifactId?: string;
  datasetId?: string;
  /**
   * Saved table view id (Laminar §B.1 / §C).
   * Canonical `viewId`; legacy `savedView` still read.
   * Never reuse hub `view=` for this.
   */
  viewId?: string;
};

/**
 * URL state for resource hubs.
 * See MASTER_DETAIL_QUERY_KEYS on CoreResourcePage for the full contract.
 */
export function useResourceUrlState() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const state = useMemo<ResourceUrlState>(
    () => ({
      view: searchParams.get("view") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      filter: searchParams.get("filter") ?? undefined,
      traceId: readMasterDetailParam(searchParams, "traceId"),
      spanId: readMasterDetailParam(searchParams, "spanId"),
      sessionId: searchParams.get("sessionId") ?? undefined,
      pastHours: searchParams.get("pastHours") ?? undefined,
      issueId: searchParams.get("issueId") ?? undefined,
      alertId: searchParams.get("alertId") ?? undefined,
      agentId: readMasterDetailParam(searchParams, "agentId"),
      experimentId: searchParams.get("experimentId") ?? undefined,
      promotionId: searchParams.get("promotionId") ?? undefined,
      artifactId: searchParams.get("artifactId") ?? undefined,
      datasetId: readMasterDetailParam(searchParams, "datasetId"),
      viewId: readMasterDetailParam(searchParams, "viewId"),
    }),
    [searchParams],
  );

  const setState = useCallback(
    (patch: Partial<ResourceUrlState>, opts?: { replace?: boolean }) => {
      const params = new URLSearchParams(searchParams.toString());
      const apply = (key: string, value: string | undefined, aliases: string[] = []) => {
        for (const alias of aliases) params.delete(alias);
        if (!value) params.delete(key);
        else params.set(key, value);
      };
      if ("view" in patch) apply("view", patch.view);
      if ("q" in patch) apply("q", patch.q);
      if ("filter" in patch) apply("filter", patch.filter);
      if ("traceId" in patch) {
        writeMasterDetailParam(params, "traceId", patch.traceId);
      }
      if ("spanId" in patch) {
        writeMasterDetailParam(params, "spanId", patch.spanId);
      }
      if ("sessionId" in patch) apply("sessionId", patch.sessionId);
      if ("pastHours" in patch) apply("pastHours", patch.pastHours);
      if ("issueId" in patch) apply("issueId", patch.issueId);
      if ("alertId" in patch) apply("alertId", patch.alertId);
      if ("agentId" in patch) {
        writeMasterDetailParam(params, "agentId", patch.agentId);
      }
      if ("experimentId" in patch) apply("experimentId", patch.experimentId);
      if ("promotionId" in patch) apply("promotionId", patch.promotionId);
      if ("artifactId" in patch) apply("artifactId", patch.artifactId);
      if ("datasetId" in patch) {
        writeMasterDetailParam(params, "datasetId", patch.datasetId);
      }
      if ("viewId" in patch) {
        writeMasterDetailParam(params, "viewId", patch.viewId);
      }
      const qs = params.toString();
      // Skip no-op navigations — identical QS still notifies subscribers and
      // re-renders hub tables / filter bars (URL thrash).
      if (qs === searchParams.toString()) return;
      const url = qs ? `?${qs}` : "";
      const nav = `${window.location.pathname}${url}`;
      if (opts?.replace === false) router.push(nav, { scroll: false });
      else router.replace(nav, { scroll: false });
    },
    [router, searchParams],
  );

  return { state, setState, MASTER_DETAIL_QUERY_KEYS };
}
