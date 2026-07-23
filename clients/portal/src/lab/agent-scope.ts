"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AGENT_LIST,
  agentById,
  type AgentFixture,
} from "@/lab/fixtures/agents";

export type AgentScopeId = "all" | (string & {});

/** Patch query params without losing unrelated keys (id, agent, tab, board). */
export function useQueryPatch() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? "";

  return useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === "") params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
}

export function useAgentScope() {
  const searchParams = useSearchParams();
  const patchQuery = useQueryPatch();

  const raw = searchParams.get("agent");
  const agentId: AgentScopeId =
    raw && AGENT_LIST.some((a) => a.id === raw) ? raw : "all";
  const agent = agentId === "all" ? undefined : agentById(agentId);

  const setAgentId = useCallback(
    (id: AgentScopeId) => {
      patchQuery({ agent: id === "all" ? null : id });
    },
    [patchQuery],
  );

  /** Build a lab href that keeps the current agent scope. */
  const hrefFor = useCallback(
    (base: string, extra?: Record<string, string | undefined>) => {
      const params = new URLSearchParams();
      if (agentId !== "all") params.set("agent", agentId);
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          if (v) params.set(k, v);
        }
      }
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    },
    [agentId],
  );

  return {
    agentId,
    agent,
    setAgentId,
    hrefFor,
    agents: AGENT_LIST,
  };
}

export function groupByAgent<T extends { agentId: string }>(
  items: T[],
): { agent: AgentFixture; items: T[] }[] {
  return AGENT_LIST.map((agent) => ({
    agent,
    items: items.filter((item) => item.agentId === agent.id),
  })).filter((group) => group.items.length > 0);
}

export function agentScopeCounts<T extends { agentId: string }>(
  items: T[],
): Record<string, number> {
  const counts: Record<string, number> = { all: items.length };
  for (const agent of AGENT_LIST) {
    counts[agent.id] = items.filter((item) => item.agentId === agent.id).length;
  }
  return counts;
}
