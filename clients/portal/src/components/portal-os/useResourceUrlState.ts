"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export type ResourceUrlState = {
  view?: string;
  q?: string;
  filter?: string;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  pastHours?: string;
  issueId?: string;
  alertId?: string;
  experimentId?: string;
  promotionId?: string;
  artifactId?: string;
};

export function useResourceUrlState() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const state = useMemo<ResourceUrlState>(() => ({
    view: searchParams.get("view") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    filter: searchParams.get("filter") ?? undefined,
    traceId:
      searchParams.get("traceId") ??
      searchParams.get("trace_id") ??
      undefined,
    spanId: searchParams.get("spanId") ?? searchParams.get("span_id") ?? undefined,
    sessionId: searchParams.get("sessionId") ?? undefined,
    pastHours: searchParams.get("pastHours") ?? undefined,
    issueId: searchParams.get("issueId") ?? undefined,
    alertId: searchParams.get("alertId") ?? undefined,
    experimentId: searchParams.get("experimentId") ?? undefined,
    promotionId: searchParams.get("promotionId") ?? undefined,
    artifactId: searchParams.get("artifactId") ?? undefined,
  }), [searchParams]);

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
        apply("traceId", patch.traceId, ["trace_id", "trace"]);
      }
      if ("spanId" in patch) apply("spanId", patch.spanId, ["span_id"]);
      if ("sessionId" in patch) apply("sessionId", patch.sessionId);
      if ("pastHours" in patch) apply("pastHours", patch.pastHours);
      if ("issueId" in patch) apply("issueId", patch.issueId);
      if ("alertId" in patch) apply("alertId", patch.alertId);
      if ("experimentId" in patch) apply("experimentId", patch.experimentId);
      if ("promotionId" in patch) apply("promotionId", patch.promotionId);
      if ("artifactId" in patch) apply("artifactId", patch.artifactId);
      const qs = params.toString();
      const url = qs ? `?${qs}` : "";
      const nav = `${window.location.pathname}${url}`;
      if (opts?.replace === false) router.push(nav, { scroll: false });
      else router.replace(nav, { scroll: false });
    },
    [router, searchParams],
  );

  return { state, setState };
}
