"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { ConnectRepoPanel } from "@/components/agents/ConnectRepoPanel";
import {
  clearStoredInstallAgentId,
  readStoredInstallAgentId,
} from "@/lib/github-install";

function ConnectInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const agentFromQuery = searchParams.get("agent");
  const [agentId, setAgentId] = useState<string | null>(agentFromQuery);

  // GitHub callback drops ?agent= — restore from sessionStorage after install.
  useEffect(() => {
    if (agentFromQuery) {
      setAgentId(agentFromQuery);
      return;
    }
    const stored = readStoredInstallAgentId();
    if (!stored) return;
    setAgentId(stored);
    const params = new URLSearchParams(searchParams.toString());
    params.set("agent", stored);
    clearStoredInstallAgentId();
    router.replace(`/agents/connect?${params.toString()}`);
  }, [agentFromQuery, router, searchParams]);

  return (
    <div className="ds-page">
      <PageHeader
        title="Connect repository"
        meta={
          <span className="type-meta">
            {agentId
              ? `Repo for ${agentId}`
              : "Pick an agent first, then link its GitHub repo"}
          </span>
        }
        actions={
          <Link
            href={agentId ? `/agents?id=${encodeURIComponent(agentId)}` : "/agents"}
            className="ds-btn ds-btn-ghost ds-btn-sm"
          >
            Back to Agents
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 py-6 sm:px-6">
        <ConnectRepoPanel agentId={agentId} />
      </div>
    </div>
  );
}

export default function AgentsConnectPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Connect repository" />
        </div>
      }
    >
      <ConnectInner />
    </Suspense>
  );
}
