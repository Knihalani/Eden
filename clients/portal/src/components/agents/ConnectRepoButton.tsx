"use client";

import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { githubApi } from "@/lib/api/resources";
import { ApiError } from "@/lib/api/core";
import { LIVE_QUERY } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

function isValidRepoFullName(value: unknown): value is string {
  const repo = String(value ?? "").trim();
  return Boolean(repo && repo.includes("/") && !/undefined/i.test(repo));
}

/**
 * Compact header control for agent ↔ GitHub repo linking.
 * Full install / pick-repo UI lives on `/agents/connect`.
 */
export function ConnectRepoButton({
  agentId,
  className,
}: {
  agentId: string;
  className?: string;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const href = `/agents/connect?agent=${encodeURIComponent(agentId)}`;

  const connection = useOrgQuery(
    queryKeys.github.connection(orgId, agentId),
    orgId,
    async () => {
      try {
        return await githubApi.getConnection(orgId!, agentId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
    { ...LIVE_QUERY, staleTime: 10_000, enabled: Boolean(orgId) },
  );

  const repo =
    connection.data && isValidRepoFullName(connection.data.repo_full_name)
      ? String(connection.data.repo_full_name).trim()
      : null;

  if (connection.isPending) {
    return (
      <span
        className={cn(
          "ds-btn ds-btn-outline ds-btn-sm pointer-events-none opacity-60",
          className,
        )}
      >
        Repo…
      </span>
    );
  }

  if (repo) {
    return (
      <Link
        href={href}
        className={cn("ds-btn ds-btn-outline ds-btn-sm max-w-[14rem]", className)}
        title={`Connected · ${repo}`}
      >
        <span className="truncate">{repo}</span>
      </Link>
    );
  }

  return (
    <Link href={href} className={cn("ds-btn ds-btn-primary ds-btn-sm", className)}>
      Connect repo
    </Link>
  );
}
