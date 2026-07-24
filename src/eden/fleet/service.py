"""N05 — fleet health rollup, severity scoring, delegation graph.

Query budget for ``summary()`` is O(1) round-trips relative to agent
count (batched GROUP BY / ANY($1) aggregates), not O(n) per-agent
SELECTs. See tests/unit/fleet/test_fleet_summary_query_budget.py.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

# Debounce registry upserts on the agents hot path — FleetHealthService is
# constructed per request in portal/fleet routes, so TTL must be process-wide.
_ENSURE_REGISTRY_TTL_SEC = 60.0
_ensure_registry_at: dict[str, float] = {}


def _delegation_trust_score(error_rate: float, call_count: int) -> float:
    """D9 — trust in [0,1] from error rate and volume."""
    if call_count <= 0:
        return 1.0
    base = max(0.0, 1.0 - error_rate)
    volume_penalty = min(0.2, call_count / 10_000.0)
    return round(max(0.0, min(1.0, base - volume_penalty)), 3)


def _parse_slo(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _drift_flagged_from_dimensions(dims: Any) -> bool:
    if dims is None:
        return False
    if isinstance(dims, str):
        try:
            dims = json.loads(dims)
        except Exception:
            return False
    if not isinstance(dims, list):
        return False
    return any(bool(d.get("flagged")) for d in dims if isinstance(d, dict))


def _build_card(
    *,
    agent_id: str,
    registry: dict[str, Any],
    open_issues: int,
    open_p0: int,
    eval_pass_rate: float | None,
    stumble_count: int,
    drift_flagged: bool,
    autonomy_mode: str,
    compliance_profile: str,
) -> dict[str, Any]:
    slo = _parse_slo(registry.get("slo_config"))
    min_pass = float(slo.get("min_eval_pass_rate", 0.9))
    slo_breach = eval_pass_rate is not None and eval_pass_rate < min_pass
    severity = (
        open_p0 * 5.0
        + open_issues * 3.0
        + (2.0 if slo_breach else 0.0)
        + stumble_count * 0.1
        + (1.5 if drift_flagged else 0.0)
        + (1.0 if registry.get("tier") == "critical" else 0.0)
    )
    return {
        "agent_id": agent_id,
        "display_name": registry.get("display_name") or agent_id,
        "tier": registry.get("tier") or "standard",
        "open_issues": open_issues,
        "open_p0_issues": open_p0,
        "stumble_count_7d": stumble_count,
        "eval_pass_rate_24h": eval_pass_rate,
        "slo_breach": slo_breach,
        "drift_flagged": drift_flagged,
        "autonomy_mode": autonomy_mode,
        "compliance_profile": compliance_profile,
        "severity_score": round(severity, 2),
        "last_seen": (
            registry["last_seen"].isoformat()
            if registry.get("last_seen")
            else None
        ),
    }


class FleetHealthService:
    """Fleet SRE summary for portal /fleet and MCP get_fleet_health."""

    name = "fleet_health"

    async def discover_agent(
        self, org_id: str, agent_id: str, *, display_name: str | None = None
    ) -> None:
        client = await self._client()
        if client is None:
            return
        try:
            await client.execute(
                "INSERT INTO agent_registry "
                "(org_id, agent_id, display_name, first_seen, last_seen) "
                "VALUES ($1, $2, $3, NOW(), NOW()) "
                "ON CONFLICT (org_id, agent_id) DO UPDATE SET "
                "last_seen = NOW(), "
                "display_name = COALESCE(EXCLUDED.display_name, agent_registry.display_name)",
                org_id,
                agent_id,
                display_name or agent_id,
            )
        except Exception as exc:
            logger.debug("fleet: discover failed: %s", exc)

    async def refresh_delegation_edges(self, org_id: str) -> int:
        """Rebuild delegation edges from a2a_links (7d window)."""
        client = await self._client()
        if client is None:
            return 0
        try:
            await client.execute(
                "DELETE FROM agent_delegation_edges WHERE org_id = $1", org_id
            )
            result = await client.execute(
                """
                INSERT INTO agent_delegation_edges
                    (org_id, parent_agent_id, child_agent_id, call_count_7d, error_rate_7d)
                SELECT
                    org_id,
                    parent_agent_id::text,
                    child_agent_id::text,
                    COUNT(*) AS call_count_7d,
                    AVG(CASE WHEN response_status IN ('error','failed')
                        THEN 1.0 ELSE 0.0 END) AS error_rate_7d
                FROM a2a_links
                WHERE org_id = $1
                  AND created_at > NOW() - INTERVAL '7 days'
                GROUP BY org_id, parent_agent_id, child_agent_id
                """,
                org_id,
            )
            return int(str(result).split()[-1]) if result else 0
        except Exception as exc:
            logger.debug("fleet: delegation refresh failed: %s", exc)
            return 0

    async def summary(self, org_id: str) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            return {"agents": [], "count": 0}
        await self._ensure_registry_from_traces(org_id)
        agents: list[dict[str, Any]] = []
        try:
            rows = await client.fetch(
                "SELECT * FROM agent_registry WHERE org_id = $1 "
                "ORDER BY last_seen DESC NULLS LAST LIMIT 100",
                org_id,
            )
            registries = [dict(row) for row in rows]
            agent_ids = [str(r["agent_id"]) for r in registries if r.get("agent_id")]
            if not agent_ids:
                return {"agents": [], "count": 0, "sla_breach_count": 0, "critical_count": 0}

            metrics, autonomy = await asyncio.gather(
                self._batch_agent_metrics(org_id, agent_ids),
                self._batch_autonomy(org_id, agent_ids),
            )

            for registry in registries:
                agent_id = str(registry["agent_id"])
                m = metrics.get(agent_id) or {}
                a = autonomy.get(agent_id) or {}
                agents.append(
                    _build_card(
                        agent_id=agent_id,
                        registry=registry,
                        open_issues=int(m.get("open_issues") or 0),
                        open_p0=int(m.get("open_p0") or 0),
                        eval_pass_rate=m.get("eval_pass_rate"),
                        stumble_count=int(m.get("stumble_count") or 0),
                        drift_flagged=bool(m.get("drift_flagged")),
                        autonomy_mode=str(a.get("autonomy_mode") or "assisted"),
                        compliance_profile=str(
                            a.get("compliance_profile") or "standard"
                        ),
                    )
                )
        except Exception as exc:
            logger.debug("fleet: summary failed: %s", exc)
        agents.sort(key=lambda a: a.get("severity_score", 0), reverse=True)
        breaches = [a for a in agents if a.get("slo_breach")]
        return {
            "agents": agents,
            "count": len(agents),
            "sla_breach_count": len(breaches),
            "critical_count": sum(
                1 for a in agents if a.get("tier") == "critical"
            ),
        }

    async def _batch_agent_metrics(
        self, org_id: str, agent_ids: list[str]
    ) -> dict[str, dict[str, Any]]:
        """O(1) round-trips for all card metrics vs O(5n) per-agent SELECTs."""
        import asyncio

        client = await self._client()
        out: dict[str, dict[str, Any]] = {aid: {} for aid in agent_ids}
        if client is None:
            return out

        async def _issues() -> None:
            try:
                issue_rows = await client.fetch(
                    """
                    SELECT agent_id,
                           COUNT(*)::int AS open_issues,
                           COUNT(*) FILTER (WHERE severity = 'critical')::int AS open_p0
                    FROM agent_issues
                    WHERE org_id = $1
                      AND agent_id = ANY($2::text[])
                      AND status NOT IN ('resolved', 'ignored')
                    GROUP BY agent_id
                    """,
                    org_id,
                    agent_ids,
                )
                for r in issue_rows:
                    aid = str(r["agent_id"])
                    out.setdefault(aid, {})
                    out[aid]["open_issues"] = int(r["open_issues"] or 0)
                    out[aid]["open_p0"] = int(r["open_p0"] or 0)
            except Exception as exc:
                logger.debug("fleet: batch issues failed: %s", exc)

        async def _evals() -> None:
            try:
                eval_rows = await client.fetch(
                    """
                    SELECT agent_id,
                           AVG(CASE WHEN passed THEN 1.0 ELSE 0.0 END)::float AS pass_rate
                    FROM production_eval_scores
                    WHERE org_id = $1
                      AND agent_id = ANY($2::text[])
                      AND scored_at > NOW() - INTERVAL '24 hours'
                    GROUP BY agent_id
                    """,
                    org_id,
                    agent_ids,
                )
                for r in eval_rows:
                    aid = str(r["agent_id"])
                    out.setdefault(aid, {})
                    if r["pass_rate"] is not None:
                        out[aid]["eval_pass_rate"] = float(r["pass_rate"])
            except Exception as exc:
                logger.debug("fleet: batch eval failed: %s", exc)

        async def _stumbles() -> None:
            try:
                stumble_rows = await client.fetch(
                    """
                    SELECT agent_id, COUNT(*)::int AS n
                    FROM agent_stumbles
                    WHERE org_id = $1
                      AND agent_id = ANY($2::text[])
                      AND detected_at > NOW() - INTERVAL '7 days'
                    GROUP BY agent_id
                    """,
                    org_id,
                    agent_ids,
                )
                for r in stumble_rows:
                    aid = str(r["agent_id"])
                    out.setdefault(aid, {})
                    out[aid]["stumble_count"] = int(r["n"] or 0)
            except Exception as exc:
                logger.debug("fleet: batch stumbles failed: %s", exc)

        async def _drift() -> None:
            try:
                drift_rows = await client.fetch(
                    """
                    SELECT DISTINCT ON (agent_id) agent_id, dimensions
                    FROM drift_reports
                    WHERE org_id = $1
                      AND agent_id = ANY($2::text[])
                    ORDER BY agent_id, created_at DESC
                    """,
                    org_id,
                    agent_ids,
                )
                for r in drift_rows:
                    aid = str(r["agent_id"])
                    out.setdefault(aid, {})
                    out[aid]["drift_flagged"] = _drift_flagged_from_dimensions(
                        r.get("dimensions")
                    )
            except Exception as exc:
                logger.debug("fleet: batch drift failed: %s", exc)

        await asyncio.gather(_issues(), _evals(), _stumbles(), _drift())
        return out

    async def _batch_autonomy(
        self, org_id: str, agent_ids: list[str]
    ) -> dict[str, dict[str, str]]:
        """Org default once + agent overrides in one query (not N resolve())."""
        out: dict[str, dict[str, str]] = {
            aid: {"autonomy_mode": "assisted", "compliance_profile": "standard"}
            for aid in agent_ids
        }
        try:
            from eden.closed_loop.autonomy_policy import (
                _policy_from_row,
                resolve,
            )

            org_policy = await resolve(org_id, None)
            org_mode = org_policy.effective_mode()
            org_profile = org_policy.compliance_profile
            for aid in agent_ids:
                out[aid] = {
                    "autonomy_mode": org_mode,
                    "compliance_profile": org_profile,
                }

            client = await self._client()
            if client is None:
                return out
            rows = await client.fetch(
                """
                SELECT agent_id, policy, compliance_profile
                FROM autonomy_policies
                WHERE org_id = $1
                  AND agent_id = ANY($2::text[])
                """,
                org_id,
                agent_ids,
            )
            for r in rows:
                aid = str(r["agent_id"])
                policy = _policy_from_row(org_id, aid, dict(r))
                out[aid] = {
                    "autonomy_mode": policy.effective_mode(),
                    "compliance_profile": policy.compliance_profile,
                }
        except Exception as exc:
            logger.debug("fleet: batch autonomy failed: %s", exc)
        return out

    async def sla_breaches(self, org_id: str) -> dict[str, Any]:
        summary = await self.summary(org_id)
        breaches = [
            a for a in summary.get("agents") or [] if a.get("slo_breach")
        ]
        return {"breaches": breaches, "count": len(breaches)}

    async def heatmap(self, org_id: str) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            return {"cells": []}
        try:
            rows = await client.fetch(
                """
                SELECT agent_id, kind, COUNT(*) AS stumble_count
                FROM agent_stumbles
                WHERE org_id = $1
                  AND detected_at > NOW() - INTERVAL '7 days'
                  AND agent_id IS NOT NULL
                GROUP BY agent_id, kind
                ORDER BY stumble_count DESC
                LIMIT 500
                """,
                org_id,
            )
            return {
                "cells": [
                    {
                        "agent_id": r["agent_id"],
                        "stumble_kind": r["kind"],
                        "count": int(r["stumble_count"]),
                    }
                    for r in rows
                ]
            }
        except Exception as exc:
            logger.debug("fleet: heatmap failed: %s", exc)
            return {"cells": []}

    async def delegation_graph(self, org_id: str) -> dict[str, Any]:
        await self.refresh_delegation_edges(org_id)
        client = await self._client()
        if client is None:
            return {"nodes": [], "edges": []}
        try:
            edge_rows = await client.fetch(
                "SELECT * FROM agent_delegation_edges WHERE org_id = $1",
                org_id,
            )
            nodes: dict[str, dict[str, Any]] = {}
            edges = []
            for e in edge_rows:
                parent = str(e["parent_agent_id"])
                child = str(e["child_agent_id"])
                err_rate = float(e["error_rate_7d"] or 0)
                call_count = int(e["call_count_7d"] or 0)
                trust = _delegation_trust_score(err_rate, call_count)
                nodes.setdefault(
                    parent,
                    {"id": parent, "label": parent, "delegation_trust": trust},
                )
                nodes.setdefault(
                    child,
                    {"id": child, "label": child, "delegation_trust": trust},
                )
                edges.append(
                    {
                        "source": parent,
                        "target": child,
                        "call_count_7d": call_count,
                        "error_rate_7d": err_rate,
                        "delegation_trust": trust,
                        "blast_radius": round(call_count * (1.0 - trust), 2),
                    }
                )
            return {"nodes": list(nodes.values()), "edges": edges}
        except Exception as exc:
            logger.debug("fleet: delegation graph failed: %s", exc)
            return {"nodes": [], "edges": []}

    async def _agent_card(
        self, org_id: str, agent_id: str, registry: dict[str, Any]
    ) -> dict[str, Any]:
        """Single-agent card (compat). Prefer ``summary()`` batch path."""
        metrics = await self._batch_agent_metrics(org_id, [agent_id])
        autonomy = await self._batch_autonomy(org_id, [agent_id])
        m = metrics.get(agent_id) or {}
        a = autonomy.get(agent_id) or {}
        return _build_card(
            agent_id=agent_id,
            registry=registry,
            open_issues=int(m.get("open_issues") or 0),
            open_p0=int(m.get("open_p0") or 0),
            eval_pass_rate=m.get("eval_pass_rate"),
            stumble_count=int(m.get("stumble_count") or 0),
            drift_flagged=bool(m.get("drift_flagged")),
            autonomy_mode=str(a.get("autonomy_mode") or "assisted"),
            compliance_profile=str(a.get("compliance_profile") or "standard"),
        )

    async def _ensure_registry_from_traces(self, org_id: str) -> None:
        """Batch upsert agents seen in stumbles — one statement, not N UPSERTs.

        Debounced per org (process-local TTL) so ``GET /portal/agents`` does
        not rewrite ``agent_registry`` on every list poll.
        """
        now = time.monotonic()
        last = _ensure_registry_at.get(org_id, 0.0)
        if now - last < _ENSURE_REGISTRY_TTL_SEC:
            return
        client = await self._client()
        if client is None:
            return
        try:
            await client.execute(
                """
                INSERT INTO agent_registry
                    (org_id, agent_id, display_name, first_seen, last_seen)
                SELECT
                    $1,
                    s.agent_id,
                    s.agent_id,
                    NOW(),
                    NOW()
                FROM (
                    SELECT DISTINCT agent_id
                    FROM agent_stumbles
                    WHERE org_id = $1
                      AND agent_id IS NOT NULL
                    LIMIT 200
                ) AS s
                ON CONFLICT (org_id, agent_id) DO UPDATE SET
                    last_seen = NOW(),
                    display_name = COALESCE(
                        agent_registry.display_name,
                        EXCLUDED.display_name
                    )
                """,
                org_id,
            )
            _ensure_registry_at[org_id] = now
        except Exception:
            try:
                rows = await client.fetch(
                    """
                    SELECT DISTINCT agent_id FROM agent_stumbles
                    WHERE org_id = $1 AND agent_id IS NOT NULL
                    LIMIT 200
                    """,
                    org_id,
                )
                ids = [str(r["agent_id"]) for r in rows if r.get("agent_id")]
                if not ids:
                    _ensure_registry_at[org_id] = now
                    return
                await client.execute(
                    """
                    INSERT INTO agent_registry
                        (org_id, agent_id, display_name, first_seen, last_seen)
                    SELECT $1, x, x, NOW(), NOW()
                    FROM unnest($2::text[]) AS x
                    ON CONFLICT (org_id, agent_id) DO UPDATE SET
                        last_seen = NOW()
                    """,
                    org_id,
                    ids,
                )
                _ensure_registry_at[org_id] = now
            except Exception:
                pass

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None
