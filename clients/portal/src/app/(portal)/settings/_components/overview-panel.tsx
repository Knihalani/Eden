"use client";

/**
 * Workspace overview — one composition (Wave 2 + polish): identity, plan chip,
 * health row, one context-aware primary CTA, quiet secondary links.
 */

import Link from "next/link";
import type { Organization } from "@/lib/types";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrgQuery } from "@/hooks/use-api-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { NoOrgState } from "@/components/ui/no-org-state";
import { isPersonalWorkspace } from "@/lib/workspace-mode";

export const WS1_OVERVIEW_SCAFFOLD_COMPLETED = true as const;
export const WS2_OVERVIEW_COMPLETED = true as const;

export type OverviewPanelProps = {
  org: Organization | null;
};

type MemberRow = { user_id: string };
type ApiKeyRow = { id: string };
type PlanPulse = {
  plan_name?: string;
  display_name?: string;
};

function healthValue(loading: boolean, value: string): string {
  if (loading) return "Loading…";
  return value;
}

function OverviewPanelLoaded({ org }: { org: Organization }) {
  const personal = isPersonalWorkspace(org);
  const orgId = org.id;

  const planQuery = useOrgQuery(
    queryKeys.settings.billing(orgId),
    orgId,
    () => api.getPlans(orgId) as Promise<PlanPulse>,
  );
  const membersQuery = useOrgQuery(
    queryKeys.settings.members(orgId),
    orgId,
    () => api.listOrgMembers(orgId) as Promise<MemberRow[]>,
  );
  const keysQuery = useOrgQuery(
    queryKeys.settings.apiKeys(orgId),
    orgId,
    () => api.listApiKeys(orgId) as Promise<ApiKeyRow[]>,
  );

  const planLoading = planQuery.isLoading;
  const planLabel =
    planQuery.data?.display_name?.trim() ||
    planQuery.data?.plan_name?.trim() ||
    (planLoading ? "…" : "Plan");

  const membersCount = membersQuery.data?.length;
  const membersDisplay = healthValue(
    membersQuery.isLoading && membersCount == null && org.member_count == null,
    membersCount != null
      ? String(membersCount)
      : org.member_count != null
        ? String(org.member_count)
        : "—",
  );

  const keysCount = keysQuery.data?.length;
  const keysHealthy = keysCount != null && keysCount > 0;
  const keysDisplay = healthValue(
    keysQuery.isLoading && keysCount == null,
    keysCount == null ? "—" : keysHealthy ? `${keysCount} active` : "No keys yet",
  );

  let primaryHref = "/settings?tab=api-keys";
  let primaryLabel = "Manage API keys";
  let primaryCta: "create-team" | "api-keys" | "create-key" = "api-keys";
  if (personal) {
    primaryHref = "/settings?tab=org&create=1";
    primaryLabel = "Create a team workspace";
    primaryCta = "create-team";
  } else if (keysCount === 0) {
    primaryHref = "/settings?tab=api-keys";
    primaryLabel = "Create API key";
    primaryCta = "create-key";
  }

  return (
    <Panel tone="flat" padding="lg" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-lg font-medium tracking-tight text-[var(--text-primary)]">
            {org.name}
          </h2>
          <p
            className="text-sm text-[var(--text-secondary)]"
            data-ws2-overview-mode={personal ? "personal" : "team"}
          >
            {personal
              ? "Personal workspace overview"
              : "Team workspace overview"}
          </p>
        </div>
        {planLoading ? (
          <Skeleton className="h-6 w-16" data-ws2-overview-plan />
        ) : (
          <Badge
            variant="secondary"
            data-ws2-overview-plan
            data-ws1-overview-plan
          >
            {planLabel}
          </Badge>
        )}
      </header>

      <Section
        title="Health"
        description="Members, keys, and recent change history for this workspace."
      >
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--text-muted)]">Members</dt>
            <dd
              className="text-sm text-[var(--text-primary)]"
              data-ws2-overview-members
              data-ws1-overview-members
            >
              {membersDisplay}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--text-muted)]">API key health</dt>
            <dd className="text-sm">
              <Link
                href="/settings?tab=api-keys"
                className="text-[var(--accent)] hover:underline"
                data-ws2-overview-keys
                data-ws1-overview-keys
              >
                {keysDisplay}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--text-muted)]">Recent audit</dt>
            <dd className="text-sm">
              <Link
                href="/audit-trail?segment=events"
                className="text-[var(--accent)] hover:underline"
                data-ws2-overview-audit
                data-ws1-overview-audit
              >
                Open audit trail
              </Link>
            </dd>
          </div>
        </dl>
      </Section>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button asChild>
          <Link
            href={primaryHref}
            data-ws2-overview-cta={primaryCta}
            data-ws1-overview-cta={primaryCta}
          >
            {primaryLabel}
          </Link>
        </Button>
        <nav
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--text-secondary)]"
          aria-label="Overview secondary links"
        >
          <Link
            href={personal ? "/settings?tab=org&create=1" : "/settings?tab=members"}
            className="hover:text-[var(--text-primary)] hover:underline"
            data-ws2-overview-link={personal ? "upgrade" : "members"}
          >
            {personal ? "Upgrade workspace" : "Members"}
          </Link>
          <Link
            href="/settings?tab=billing"
            className="hover:text-[var(--text-primary)] hover:underline"
            data-ws2-overview-link="billing"
          >
            Billing
          </Link>
        </nav>
      </div>
    </Panel>
  );
}

export function OverviewPanel({ org }: OverviewPanelProps) {
  if (!org) {
    return (
      <div data-ws2-overview data-ws1-overview>
        <NoOrgState feature="Workspace settings" />
      </div>
    );
  }

  return (
    <div data-ws2-overview data-ws1-overview>
      <OverviewPanelLoaded org={org} />
    </div>
  );
}
