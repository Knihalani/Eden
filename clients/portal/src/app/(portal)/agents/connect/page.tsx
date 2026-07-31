"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { ConnectRepoPanel } from "@/components/agents/ConnectRepoPanel";

function ConnectInner() {
  const searchParams = useSearchParams();
  const agentId = searchParams.get("agent");

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
