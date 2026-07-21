"use client";

/**
 * Wave 6 — unified compliance reader.
 * Segments: Events (org privileged) | Chain packs (agent ledger + tools).
 * Settings ?tab=audit-log redirects here (M3/M9); sidebar sole IA entry.
 */
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrg } from "@/hooks/use-org";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { ChainPanel } from "./_components/chain-panel";
import { EventsPanel } from "./_components/events-panel";

/** Wave 6 exit marker — unified audit trail complete (keep off page export). */
const WS6_AUDIT_COMPLETED = true;

type AuditSegment = "events" | "chain";

function parseSegment(raw: string | null): AuditSegment {
  return raw === "events" ? "events" : "chain";
}

function AuditTrailPageInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [agentFilter, setAgentFilter] = useState(
    () => searchParams.get("agent") ?? "",
  );
  const segment = parseSegment(searchParams.get("segment"));

  useEffect(() => {
    const fromUrl = searchParams.get("agent") ?? "";
    setAgentFilter((prev) => (prev === fromUrl ? prev : fromUrl));
  }, [searchParams]);

  const setSegment = (next: AuditSegment) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "events") params.set("segment", "events");
    else params.delete("segment");
    const qs = params.toString();
    router.replace(qs ? `/audit-trail?${qs}` : "/audit-trail", { scroll: false });
  };

  const setAgentFromToolbar = (id: string) => {
    setAgentFilter(id);
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("agent", id);
    else params.delete("agent");
    const qs = params.toString();
    router.replace(qs ? `/audit-trail?${qs}` : "/audit-trail", { scroll: false });
  };

  if (!currentOrg || !orgId) {
    return (
      <NoOrgState
        feature="Audit trail"
        icon={ShieldCheck}
        description="Select a workspace to view privileged events and chain-verified agent audit packs."
      />
    );
  }

  return (
    <div
      data-ws6-audit="completed"
      data-ws6-audit-completed={WS6_AUDIT_COMPLETED ? "true" : "false"}
    >
      <CoreResourcePage
        size="default"
        header={
          <PageHeader
            title="Audit trail"
            subtitle="Workspace activity and Chain-verified agent events"
            actions={
              <div className="flex flex-wrap items-center gap-space-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11"
                      aria-label="Audit trail path links"
                    >
                      More
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[12rem]">
                    <DropdownMenuLabel>Go to</DropdownMenuLabel>
                    <DropdownMenuItem asChild>
                      <Link href="/agents">Agents</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/agents?tab=fleet">Fleet</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/ledger">Ledger</Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            }
          />
        }
        toolbar={
          <Tabs
            value={segment}
            onValueChange={(v) => setSegment(parseSegment(v))}
          >
            <TabsList
              variant="underline"
              aria-label="Audit trail segments"
              data-ws6-segments="events-chain"
            >
              <TabsTrigger value="events" variant="underline">
                Events
              </TabsTrigger>
              <TabsTrigger value="chain" variant="underline">
                Chain packs
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
        table={
          segment === "events" ? (
            <EventsPanel orgId={orgId} />
          ) : (
            <ChainPanel
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

export default function AuditTrailPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-2 p-6" aria-busy="true">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      }
    >
      <AuditTrailPageInner />
    </Suspense>
  );
}
