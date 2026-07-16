"use client";

import Link from "next/link";
import { ExternalLink, Key, Rocket } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { FilledSnippet } from "@/components/quickstart/FilledSnippet";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

export default function QuickstartPage() {
  const { currentOrg } = useOrg();

  if (!currentOrg) {
    return (
      <PageContent>
        <NoOrgState feature="Quickstart" />
      </PageContent>
    );
  }

  const canManage =
    currentOrg.role === "owner" || currentOrg.role === "admin";

  return (
    <PageContent>
      <PageHeader
        title="Quickstart"
        description="Fill in your credentials, copy the snippet, and send your first trace."
        icon={Rocket}
        actions={
          <Link
            href={DOCS_QUICKSTART_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline"
          >
            Full docs
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        }
      />

      <div className="mx-auto max-w-3xl space-y-6">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--text-secondary)]">
          <li>
            Click <strong className="text-[var(--text-primary)]">Fill in</strong>{" "}
            to create an API key (or reuse one from this session) and inject it
            into the snippet.
          </li>
          <li>Copy the snippet and run it in your agent project.</li>
          <li>
            Open{" "}
            <Link href="/traces" className="text-[var(--accent)] hover:underline">
              Traces
            </Link>{" "}
            — <code className="text-xs">hello-world</code> should appear within a
            minute.
          </li>
        </ol>

        <FilledSnippet orgId={currentOrg.id} canManage={canManage} />

        <p className="text-xs text-[var(--text-muted)]">
          Manage keys anytime in{" "}
          <Link
            href="/settings?tab=api-keys"
            className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
          >
            <Key className="h-3 w-3" />
            Settings → API Keys
          </Link>
          . The SDK talks to{" "}
          <code className="font-mono">https://api.edenobservability.com</code> by
          default — no base URL env var needed.
        </p>
      </div>
    </PageContent>
  );
}
