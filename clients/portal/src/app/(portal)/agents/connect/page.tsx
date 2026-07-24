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
            Tell Eden which GitHub repo holds your agent code so Improve can
            open fix PRs
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

        <section className="space-y-2">
          <h2 className="type-ui">What this enables</h2>
          <ul className="list-disc space-y-1.5 pl-4 type-meta">
            <li>
              Improve plans and issue autofixes open pull requests on the
              connected repo.
            </li>
            <li>
              One linked repo per agent — different agents can target different
              repos in the same workspace.
            </li>
            <li>
              You still approve plans in Improve before any PR is created.
            </li>
          </ul>
        </section>

        <p className="type-meta">
          Prefer the SDK path first?{" "}
          <Link href="/settings?mode=keys" className="underline">
            Create an API key
          </Link>{" "}
          and instrument traffic, then connect the repo when you want Eden to
          ship fixes.
        </p>
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
