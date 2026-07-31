"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { githubApi, type GitHubRepo } from "@/lib/api/resources";
import { ApiError } from "@/lib/api/core";
import { useLabToast } from "@/lab/lab-toast";
import { LIVE_QUERY, SHELL_QUERY } from "@/lib/portal-query";
import {
  clearStoredInstallationId,
  parseInstallationId,
  storeInstallationId,
} from "@/lib/github-install";
import { cn } from "@/lib/utils";

function isValidRepoFullName(value: unknown): value is string {
  const repo = String(value ?? "").trim();
  return Boolean(repo && repo.includes("/") && !/undefined/i.test(repo));
}

/**
 * Connect the GitHub repo Eden opens Improve / fix PRs against for one agent.
 *
 * One linked repo per agent — the same workspace can have many agents with
 * different repos.
 */
export function ConnectRepoPanel({
  agentId,
  compact = false,
}: {
  /** Agent this repo link belongs to (required for per-agent linking). */
  agentId?: string | null;
  compact?: boolean;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { pushToast } = useLabToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const claimedRef = useRef<number | null>(null);
  const errorShownRef = useRef<string | null>(null);

  const configured = useOrgQuery(
    queryKeys.github.configured,
    orgId,
    () => githubApi.configured(),
    { ...SHELL_QUERY, staleTime: 120_000, enabled: Boolean(orgId) },
  );
  const connection = useOrgQuery(
    queryKeys.github.connection(orgId, agentId),
    orgId,
    async () => {
      try {
        return await githubApi.getConnection(orgId!, agentId);
      } catch (err) {
        // No row / route gap → treat as disconnected, not a hard error.
        if (err instanceof ApiError && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
    { ...LIVE_QUERY, staleTime: 10_000 },
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

  const active = useMemo(() => {
    const row = connection.data;
    if (!row || !isValidRepoFullName(row.repo_full_name)) return null;
    return {
      ...row,
      repo_full_name: String(row.repo_full_name).trim(),
    };
  }, [connection.data]);
  const githubHref = active
    ? `https://github.com/${active.repo_full_name}`
    : null;
  const branchLabel = active?.default_branch?.trim() || null;
  const filteredRepos = useMemo(() => {
    const list = repos.data ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => r.full_name.toLowerCase().includes(q));
  }, [repos.data, filter]);

  const appSlug = configured.data?.app_slug?.trim() || "eden-observability";
  const appLandingHref = `https://github.com/apps/${encodeURIComponent(appSlug)}`;

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.github.connection(orgId, agentId),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.github.repos(orgId),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.github.all,
    });
  }, [agentId, orgId, queryClient]);

  // Claim installation after GitHub redirects back with ?installation_id=.
  useEffect(() => {
    if (!orgId) return;
    const fromQuery = parseInstallationId(searchParams.get("installation_id"));
    if (!fromQuery) return;
    if (claimedRef.current === fromQuery) return;
    claimedRef.current = fromQuery;
    storeInstallationId(fromQuery);
    let cancelled = false;
    setClaiming(true);
    void (async () => {
      try {
        await githubApi.claimInstallation(orgId, fromQuery);
        if (cancelled) return;
        clearStoredInstallationId();
        pushToast({
          title: "GitHub App installed",
          body: "Pick the repository that holds this agent’s code.",
          tone: "ok",
        });
        setPickerOpen(true);
        await invalidate();
      } catch (err) {
        if (cancelled) return;
        pushToast({
          title: "Couldn't register GitHub install",
          body: err instanceof Error ? err.message : "Try Install GitHub App again",
          tone: "fail",
        });
      } finally {
        if (!cancelled) setClaiming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invalidate, orgId, pushToast, searchParams]);

  useEffect(() => {
    const err = searchParams.get("error");
    if (!err || errorShownRef.current === err) return;
    errorShownRef.current = err;
    pushToast({
      title: "GitHub connect failed",
      body:
        err === "state_not_found"
          ? "Install session expired — start Connect repo again."
          : err === "installation_token_failed"
            ? "GitHub accepted the install but Eden couldn’t verify it. Retry Install GitHub App."
            : err,
      tone: "fail",
    });
  }, [pushToast, searchParams]);

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
      if (!agentId) {
        pushToast({
          title: "Select an agent first",
          body: "Repo linking is per agent — open an agent, then connect its repo.",
          tone: "fail",
        });
        return;
      }
      setBusy(true);
      try {
        await githubApi.connectRepo(orgId, {
          installation_id: repo.installation_id,
          repo_full_name: repo.full_name,
          default_branch: repo.default_branch || "main",
          agent_id: agentId,
        });
        pushToast({
          title: "Repo connected",
          body: `Improve PRs for ${agentId} will open on ${repo.full_name}`,
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
    [agentId, invalidate, orgId, pushToast],
  );

  if (!orgId) {
    return (
      <p className="type-meta">Select a workspace to connect a repository.</p>
    );
  }

  // Repo linking is per-agent. Do not show a connect CTA when no agent is
  // selected (empty Agents dashboard / connect page without ?agent=).
  if (!agentId) {
    return (
      <div
        className={cn(
          "border border-[var(--line)] bg-[var(--bg)]",
          compact ? "p-4" : "p-5 sm:p-6",
        )}
        data-testid="connect-repo-panel-no-agent"
      >
        <p className="type-ui">Select an agent first</p>
        <p className="type-meta mt-1 max-w-xl">
          Each agent has its own PR target. Open an agent from the fleet list,
          then connect the GitHub repo that holds that agent’s code.
        </p>
        <Link href="/agents" className="ds-btn ds-btn-outline ds-btn-sm mt-3">
          Back to Agents
        </Link>
      </div>
    );
  }

  const agentHint = "Improve opens fix PRs on this repo for this agent.";

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
            {connection.isPending
              ? "Repository"
              : active
                ? "Repository"
                : "Connect repository"}
          </h3>
          <p className="type-meta max-w-xl">
            {connection.isPending
              ? "Checking link…"
              : active
                ? agentHint
                : "Link the GitHub repo that holds this agent’s code."}
          </p>
        </div>
        {connection.isPending ? (
          <span className="type-meta shrink-0 rounded border border-[var(--line)] px-2 py-1 text-[var(--text-secondary)]">
            Checking…
          </span>
        ) : connection.isError ? (
          <button
            type="button"
            className="type-meta shrink-0 rounded border border-[var(--error)] px-2 py-1 text-[var(--error)]"
            onClick={() => void connection.refetch()}
          >
            Couldn’t load · retry
          </button>
        ) : active ? (
          <span className="type-meta shrink-0 rounded border border-[var(--line)] px-2 py-1">
            Connected
          </span>
        ) : (
          <span className="type-meta shrink-0 rounded border border-[var(--line)] px-2 py-1 text-[var(--text-secondary)]">
            Not connected
          </span>
        )}
      </div>

      {connection.isError ? (
        <p className="type-meta mt-4 text-[var(--error)]">
          Couldn’t verify the GitHub link for this agent. Retry, or reconnect
          below.
        </p>
      ) : null}

      {active ? (
        <div className="mt-4 space-y-3">
          <div>
            <p className="type-ui !text-[1rem]">{active.repo_full_name}</p>
            <p className="type-meta mt-1">
              {branchLabel
                ? `Default branch · ${branchLabel}`
                : "Default branch unknown"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {githubHref ? (
              <a
                href={githubHref}
                target="_blank"
                rel="noopener noreferrer"
                className="ds-btn ds-btn-outline ds-btn-sm"
              >
                Open on GitHub
              </a>
            ) : null}
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
                href={`/agents?id=${encodeURIComponent(agentId)}`}
                className="ds-btn ds-btn-ghost ds-btn-sm"
              >
                Back to agent
              </Link>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="type-meta max-w-xl">
            {claiming
              ? "Registering the GitHub App installation…"
              : "Install the Eden GitHub App, then choose a repo."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={busy || claiming || configured.data?.configured === false}
              onClick={() => void startInstall()}
            >
              {busy ? "Redirecting…" : claiming ? "Registering…" : "Install GitHub App"}
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-outline ds-btn-sm"
              disabled={busy || claiming}
              onClick={() => setPickerOpen(true)}
            >
              Choose repo
            </button>
          </div>
          {configured.data?.configured === false ? (
            <p className="type-meta text-[var(--error)]">
              GitHub App is not configured on this Eden instance.
            </p>
          ) : (
            <p className="type-meta max-w-xl text-[var(--text-secondary)]">
              If GitHub says the app is private, the App owner must set{" "}
              <span className="text-[var(--text)]">Where can this GitHub App be installed?</span>{" "}
              to <span className="text-[var(--text)]">Any account</span> on{" "}
              <a
                href={appLandingHref}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                github.com/apps/{appSlug}
              </a>
              . That setting is on GitHub, not in Eden.
            </p>
          )}
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
          {repos.isLoading || claiming ? (
            <p className="type-meta">
              {claiming ? "Registering install…" : "Loading repos…"}
            </p>
          ) : repos.isError ? (
            <div className="space-y-2">
              <p className="type-meta text-[var(--error)]">
                Couldn&apos;t list repos. Install the GitHub App first, or ask
                an admin with integrations:write.
              </p>
              <p className="type-meta text-[var(--text-secondary)]">
                Seeing “private GitHub App” on GitHub? The App must be public
                (“Any account”) before other orgs can install it.
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
