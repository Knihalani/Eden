"use client";

/**
 * /audit — Events + AuditPacks (surfaces/audit.md).
 * /audit-trail redirects here.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/ui/page-header";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrg } from "@/hooks/use-org";
import { ShieldCheck } from "lucide-react";
import { EventsPanel } from "./_components/events-panel";
import { PacksPanel } from "./_components/packs-panel";

export const AUDIT_TABS = ["events", "packs"] as const;
export type AuditTab = (typeof AUDIT_TABS)[number];

function parseTab(raw: string | null): AuditTab {
  if (raw === "packs" || raw === "chain") return "packs";
  return "events";
}

function AuditPageInner() {
  const t = useTranslations("audit");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [agentFilter, setAgentFilter] = useState(
    () => searchParams.get("agentId") ?? searchParams.get("agent") ?? "",
  );
  const tab = parseTab(searchParams.get("tab"));

  useEffect(() => {
    const fromUrl =
      searchParams.get("agentId") ?? searchParams.get("agent") ?? "";
    setAgentFilter((prev) => (prev === fromUrl ? prev : fromUrl));
  }, [searchParams]);

  const setTab = (next: AuditTab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("segment");
    if (next === "events") params.set("tab", "events");
    else params.set("tab", "packs");
    const qs = params.toString();
    router.replace(qs ? `/audit?${qs}` : "/audit", { scroll: false });
  };

  const setAgentFromToolbar = (id: string) => {
    setAgentFilter(id);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("agent");
    if (id) params.set("agentId", id);
    else params.delete("agentId");
    const qs = params.toString();
    router.replace(qs ? `/audit?${qs}` : "/audit", { scroll: false });
  };

  if (!currentOrg || !orgId) {
    return (
      <NoOrgState
        feature={t("title")}
        icon={ShieldCheck}
        description={t("noOrg")}
      />
    );
  }

  return (
    <div data-phase7-audit="live">
      <ResourcePageShell
        header={
          <PageHeader
            title={t("title")}
            subtitle={t("subtitle")}
            actions={
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Link
                  href="/settings?tab=retention"
                  className="text-[var(--text-muted)] hover:text-[var(--accent)]"
                >
                  {t("links.retention")}
                </Link>
                <Link
                  href="/settings?tab=pii"
                  className="text-[var(--text-muted)] hover:text-[var(--accent)]"
                >
                  {t("links.pii")}
                </Link>
              </div>
            }
          />
        }
        toolbar={
          <Tabs value={tab} onValueChange={(v) => setTab(parseTab(v))}>
            <TabsList variant="underline" aria-label={t("tabsAria")}>
              <TabsTrigger value="events" variant="underline">
                {t("tabs.events")}
              </TabsTrigger>
              <TabsTrigger value="packs" variant="underline">
                {t("tabs.packs")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
        table={
          tab === "events" ? (
            <EventsPanel orgId={orgId} />
          ) : (
            <PacksPanel
              orgId={orgId}
              agentFilter={agentFilter}
              onAgentFilterChange={setAgentFromToolbar}
            />
          )
        }
      />
    </div>
  );
}

export default function AuditPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-2 p-6" aria-busy="true">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      }
    >
      <AuditPageInner />
    </Suspense>
  );
}
