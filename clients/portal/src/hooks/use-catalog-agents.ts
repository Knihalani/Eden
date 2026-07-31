"use client";

import { useEffect } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useOrg } from "@/hooks/use-org";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import { catalogAgents, patchPortalCatalog } from "@/lib/portal-catalog";
import type { AgentFixture } from "@/lab/fixtures/agents";

/**
 * `catalogAgents()` reads a plain module-level snapshot — it's not
 * reactive, so a component that only calls it directly (no query
 * subscription of its own) won't re-render when another part of the
 * tree patches the catalog after its agents fetch resolves. Most
 * pages sidestep this by already running their own `agents` query,
 * which re-renders them for free; this hook gives shared/leaf
 * components (e.g. `AgentScopeFilter`) the same subscription without
 * duplicating the fetch — React Query dedupes by query key, so this
 * is a cache hit almost everywhere, not a second request.
 */
export function useCatalogAgents(): AgentFixture[] {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const agentsQuery = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    SHELL_QUERY,
  );

  useEffect(() => {
    if (agentsQuery.data === undefined) return;
    patchPortalCatalog({ agents: agentsQuery.data });
  }, [agentsQuery.data]);

  return agentsQuery.data ?? catalogAgents();
}
