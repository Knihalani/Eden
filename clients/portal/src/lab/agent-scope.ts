"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  agentById,
  type AgentFixture,
} from "@/lab/fixtures/agents";
import { catalogAgents } from "@/lib/portal-catalog";

export type AgentScopeId = "all" | (string & {});

function liveAgentList(): AgentFixture[] {
  return catalogAgents();
}

function stubAgent(id: string): AgentFixture {
  const label = id.trim() || "unknown";
  return {
    id: label,
    name: label,
    purpose: "",
    status: "idle",
    env: "prod",
    model: "",
    runs24h: 0,
    successRate: 1,
    errorRate: 0,
    p50Ms: 0,
    p95Ms: 0,
    costUsd24h: 0,
    tokens24h: 0,
    openIssues: 0,
    lastSeen: "",
  };
}

/** Patch query params without losing unrelated keys (id, agent, tab, board). */
export function useQueryPatch() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  // Optimistic qs so rapid tab clicks (Tree → Ask) don't race on a
  // stale `searchParams` snapshot from the previous replace.
  const qsRef = useRef(searchParams.toString());
  useEffect(() => {
    qsRef.current = searchParams.toString();
  }, [searchParams]);

  return useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const params = new URLSearchParams(qsRef.current);
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === "") params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      qsRef.current = qs;
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router],
  );
}

export function useAgentScope() {
  const searchParams = useSearchParams();
  const patchQuery = useQueryPatch();
  // Read catalog each render — PortalCatalogSync + sibling RQ updates
  // drive re-renders; grouping also synthesizes from live items.
  const agents = liveAgentList();

  const raw = searchParams.get("agent");
  const agentId: AgentScopeId =
    raw && raw.length > 0 ? raw : "all";
  const agent =
    agentId === "all"
      ? undefined
      : agentById(agentId) ?? stubAgent(agentId);

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
    agents,
  };
}

/**
 * Group runs by agent. Uses live catalog agents and synthesizes stubs for
 * SDK agent_ids that are not registered yet (empty AGENT_LIST seed).
 */
export function groupByAgent<T extends { agentId: string }>(
  items: T[],
): { agent: AgentFixture; items: T[] }[] {
  const known = new Map(liveAgentList().map((a) => [a.id, a]));
  const groups = new Map<string, { agent: AgentFixture; items: T[] }>();

  for (const item of items) {
    const id = (item.agentId || "").trim() || "unknown";
    let group = groups.get(id);
    if (!group) {
      group = {
        agent: known.get(id) ?? stubAgent(id),
        items: [],
      };
      groups.set(id, group);
    }
    group.items.push(item);
  }

  return [...groups.values()];
}

export function agentScopeCounts<T extends { agentId: string }>(
  items: T[],
): Record<string, number> {
  const counts: Record<string, number> = { all: items.length };
  for (const agent of liveAgentList()) {
    counts[agent.id] = items.filter((item) => item.agentId === agent.id).length;
  }
  for (const item of items) {
    const id = (item.agentId || "").trim();
    if (!id) continue;
    if (counts[id] == null) {
      counts[id] = items.filter((i) => i.agentId === id).length;
    }
  }
  return counts;
}
