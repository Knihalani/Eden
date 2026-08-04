"use client";

/**
 * U03 Playgrounds — list surface. Iterate prompts/models on
 * production-derived rows; each row links into the editor at
 * /playgrounds/[id].
 */

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader, Panel } from "@/components/ds/primitives";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { SHELL_QUERY } from "@/lib/portal-query";
import { queryKeys } from "@/lib/query-keys";
import { playgroundApi, type PersistedPlayground } from "@/lib/api/resources";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { EmptyState } from "@/lab/lab-ui";
import { useLabToast } from "@/lab/lab-toast";
import {
  defaultTask,
  lastRunCost,
  modelSummary,
  serializePlaygroundConfig,
} from "@/lab/playgrounds/model";

function formatWhen(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PlaygroundsPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const [creating, setCreating] = useState(false);

  const listQuery = useOrgQuery(
    queryKeys.portal.playgrounds(orgId),
    orgId,
    () => playgroundApi.list(orgId!),
    SHELL_QUERY,
  );

  async function createBlank() {
    if (!orgId || creating) return;
    setCreating(true);
    try {
      const res = await playgroundApi.create(orgId, {
        name: "Untitled playground",
        config: serializePlaygroundConfig({
          tasks: [defaultTask()],
          rows: [{ input: "" }],
          datasetId: null,
          runs: [],
        }),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portal.playgrounds(orgId),
      });
      router.push(`/playgrounds/${res.playground.id}`);
    } catch (e) {
      setCreating(false);
      pushToast({
        title: "Could not create playground",
        body: e instanceof Error ? e.message : "Create failed.",
        tone: "fail",
      });
    }
  }

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Playgrounds"
        message="Select a workspace to view playgrounds."
      />
    );
  }

  const playgrounds: PersistedPlayground[] = listQuery.data?.playgrounds ?? [];

  return (
    <div className="ds-page">
      <PageHeader
        title="Playgrounds"
        meta={
          <span className="type-meta">
            {playgrounds.length > 0
              ? `${playgrounds.length} playground${playgrounds.length === 1 ? "" : "s"}`
              : null}
          </span>
        }
        actions={
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={creating}
            onClick={() => void createBlank()}
          >
            {creating ? "Creating…" : "New playground"}
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
        {listQuery.isError ? (
          <QueryErrorPanel
            error={listQuery.error}
            onRetry={() => void listQuery.refetch()}
          />
        ) : listQuery.isLoading ? (
          <QueryLoadingPanel label="Loading playgrounds…" />
        ) : playgrounds.length === 0 ? (
          <EmptyState
            title="No playgrounds yet"
            body="Replay a production span or attach a dataset to compare prompts before you ship."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Link href="/traces" className="ds-btn ds-btn-ghost ds-btn-sm">
                  Open from Traces
                </Link>
                <button
                  type="button"
                  className="ds-btn ds-btn-primary ds-btn-sm"
                  disabled={creating}
                  onClick={() => void createBlank()}
                >
                  Create playground
                </button>
              </div>
            }
          />
        ) : (
          <Panel className="overflow-hidden !p-0">
            <ul className="divide-y divide-[var(--line)]">
              {playgrounds.map((p) => {
                const cost = lastRunCost(p.config);
                return (
                  <li key={p.id}>
                    <Link
                      href={`/playgrounds/${p.id}`}
                      className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-[var(--bg-hover)] sm:px-5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="type-ui truncate text-[var(--text)]">
                          {p.name}
                        </p>
                        <p className="type-meta mt-0.5 truncate">
                          Updated {formatWhen(p.updated_at ?? p.created_at)}
                          {" · "}
                          {modelSummary(p.config)}
                        </p>
                      </div>
                      <span className="type-value shrink-0 tabular-nums text-[var(--text-muted)]">
                        {cost != null ? `$${cost.toFixed(4)}` : "—"}
                        <span className="type-meta ml-1">last run</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}
