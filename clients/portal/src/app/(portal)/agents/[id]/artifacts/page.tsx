"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useOrg } from "@/hooks/use-org";
import { learnApi } from "@/lib/api";

export default function AgentArtifactsPage() {
  const params = useParams<{ id: string }>();
  const agentId = useMemo(
    () => (params?.id ? decodeURIComponent(params.id) : ""),
    [params?.id],
  );
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [artifacts, setArtifacts] = useState<Array<Record<string, unknown>>>([]);

  const load = useCallback(async () => {
    if (!currentOrg || !agentId) return;
    setLoading(true);
    const res = await learnApi.listArtifacts(currentOrg.id, agentId);
    setArtifacts((res.data?.artifacts as Array<Record<string, unknown>>) ?? []);
    setLoading(false);
  }, [currentOrg, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageContent>
      <PageHeader title="Agent Artifacts" description={`Runtime fixes for ${agentId}`} />
      <Link
        href={`/agents/${encodeURIComponent(agentId)}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--text-secondary)]"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to agent
      </Link>
      {loading ? (
        <Loader2 className="h-8 w-8 animate-spin" />
      ) : artifacts.length === 0 ? (
        <EmptyState
          title="No artifacts for this agent"
          description="Shadow candidates appear after issues resolve or loop detectors fire."
        />
      ) : (
        <div className="space-y-2">
          {artifacts.map((a) => (
            <Card key={String(a.id)} className="p-4">
              <div className="font-medium">{String(a.name)}</div>
              <div className="text-xs text-[var(--text-muted)]">{String(a.mode)}</div>
            </Card>
          ))}
        </div>
      )}
    </PageContent>
  );
}
