"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { githubApi, type GitHubRepo } from "@/lib/api/resources";
import { ApiError } from "@/lib/api/core";
import { useLabToast } from "@/lab/lab-toast";
import { SHELL_QUERY } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

/**
 * Connect the org's GitHub repo that Eden opens Improve / fix PRs against.
 *
 * Honest model: one active repo per workspace (not per agent). Agents
 * in this org share that PR target until multi-repo linking ships.
 */
export function ConnectRepoPanel({
  agentId,
  compact = false,
}: {
  /** Optional agent context for copy / deep links. */
  agentId?: string | null;
  compact?: boolean;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { pushToast } = useLabToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const configured = useOrgQuery(
    queryKeys.github.configured,
    orgId,
    () => githubApi.configured(),
    { ...SHELL_QUERY, staleTime: 120_000, enabled: Boolean(orgId) },
  );
  const connection = useOrgQuery(
    queryKeys.github.connection(orgId),
    orgId,
    async () => {
      try {
        return await githubApi.getConnection(orgId!);
      } catch (err) {
        // No row / route gap → treat as disconnected, not a hard error.
        if (err instanceof ApiError && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
    { ...SHELL_QUERY, staleTime: 30_000 },
  );
  const repos = useOrgQuery(
    queryKeys.github.repos(orgId),
    orgId,
    () => githubApi.listRepos(orgId!),
    {
      ...SHELL_QUERY,
      staleTime: 60_000,
      enabled: Boolean(orgId) && pickerOpen,
    },
  );

  const active = connection.data;
  const filteredRepos = useMemo(() => {
    const list = repos.data ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => r.full_name.toLowerCase().includes(q));
  }, [repos.data, filter]);

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.github.connection(orgId),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.github.repos(orgId),
    });
  }, [orgId, queryClient]);

  const startInstall = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      const { install_url } = await githubApi.authorize(orgId);
      window.location.assign(install_url);
    } catch (err) {
      pushToast({
        title: "Couldn't start GitHub install",
        body: err instanceof Error ? err.message : "Try again",
        tone: "fail",
      });
      setBusy(false);
    }
  }, [orgId, pushToast]);

  const connect = useCallback(
    async (repo: GitHubRepo) => {
      if (!orgId) return;
      setBusy(true);
      try {
        await githubApi.connectRepo(orgId, {
          installation_id: repo.installation_id,
          repo_full_name: repo.full_name,
          default_branch: repo.default_branch || "main",
        });
        pushToast({
          title: "Repo connected",
          body: `Improve PRs will open on ${repo.full_name}`,
          tone: "ok",
        });
        setPickerOpen(false);
        await invalidate();
      } catch (err) {
        pushToast({
          title: "Couldn't connect repo",
          body: err instanceof Error ? err.message : "Try again",
          tone: "fail",
        });
      } finally {
        setBusy(false);
      }
    },
    [invalidate, orgId, pushToast],
  );

  if (!orgId) {
    return (
      <p className="type-meta">Select a workspace to connect a repository.</p>
    );
  }

  const agentHint = agentId
    ? `Issues and Improve plans for ${agentId} open PRs on this repo.`
    : "When Eden proposes a fix, it opens a PR on this repository.";

  return (
    <div
      className={cn(
        "border border-[var(--line)] bg-[var(--bg)]",
        compact ? "p-4" : "p-5 sm:p-6",
      )}
      data-testid="connect-repo-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="type-ui">
            {active ? "Repository for fix PRs" : "Connect a repository"}
          </h3>
          <p className="type-meta max-w-xl">
            {active
              ? agentHint
              : "Link the GitHub repo that contains your agent code. Eden uses it to open pull requests that fix issues and Improve plans."}
          </p>
        </div>
        {active ? (
          <span className="type-meta shrink-0 rounded border border-[var(--line)] px-2 py-1">
            Connected
          </span>
        ) : (
          <span className="type-meta shrink-0 rounded border border-[var(--line)] px-2 py-1 text-[var(--text-secondary)]">
            Not connected
          </span>
        )}
      </div>

      {active ? (
        <div className="mt-4 space-y-3">
          <div>
            <p className="type-ui !text-[1rem]">{active.repo_full_name}</p>
            <p className="type-meta mt-1">
              Default branch · {active.default_branch || "main"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={`https://github.com/${active.repo_full_name}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ds-btn ds-btn-outline ds-btn-sm"
            >
              Open on GitHub
            </a>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={busy}
              onClick={() => setPickerOpen((v) => !v)}
            >
              {pickerOpen ? "Cancel" : "Switch repo"}
            </button>
            {agentId ? (
              <Link
                href={`/improve?agent=${encodeURIComponent(agentId)}`}
                className="ds-btn ds-btn-ghost ds-btn-sm"
              >
                Go to Improve
              </Link>
            ) : (
              <Link href="/improve" className="ds-btn ds-btn-ghost ds-btn-sm">
                Go to Improve
              </Link>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <ol className="list-decimal space-y-1.5 pl-4 type-meta">
            <li>Install the Eden GitHub App on your org (admin).</li>
            <li>Pick the repo that holds this agent&apos;s source.</li>
            <li>Approve Improve plans — Eden opens PRs on that repo.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={busy || configured.data?.configured === false}
              onClick={() => void startInstall()}
            >
              {busy ? "Redirecting…" : "Install GitHub App"}
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-outline ds-btn-sm"
              disabled={busy}
              onClick={() => setPickerOpen(true)}
            >
              Choose repo
            </button>
          </div>
          {configured.data?.configured === false ? (
            <p className="type-meta text-[var(--error)]">
              GitHub App is not configured on this Eden instance.
            </p>
          ) : null}
        </div>
      )}

      {pickerOpen ? (
        <div className="mt-4 border-t border-[var(--line)] pt-4">
          <label className="type-meta block mb-2" htmlFor="repo-filter">
            Search repositories
          </label>
          <input
            id="repo-filter"
            className="ds-input mb-3 w-full max-w-md"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="owner/name"
            autoComplete="off"
          />
          {repos.isLoading ? (
            <p className="type-meta">Loading repos…</p>
          ) : repos.isError ? (
            <div className="space-y-2">
              <p className="type-meta text-[var(--error)]">
                Couldn&apos;t list repos. Install the GitHub App first, or ask
                an admin with integrations:write.
              </p>
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                disabled={busy}
                onClick={() => void startInstall()}
              >
                Install GitHub App
              </button>
            </div>
          ) : filteredRepos.length === 0 ? (
            <p className="type-meta">
              No repos found. Install the App and grant repo access, then
              retry.
            </p>
          ) : (
            <ul className="max-h-64 overflow-auto border border-[var(--line)] divide-y divide-[var(--line)]">
              {filteredRepos.map((repo) => (
                <li
                  key={`${repo.installation_id}:${repo.full_name}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="type-ui truncate">{repo.full_name}</p>
                    <p className="type-meta">
                      {repo.private ? "Private" : "Public"} ·{" "}
                      {repo.default_branch || "main"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="ds-btn ds-btn-primary ds-btn-sm shrink-0"
                    disabled={busy}
                    onClick={() => void connect(repo)}
                  >
                    Use this repo
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
