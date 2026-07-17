"""N05 — fleet health rollup, severity scoring, delegation graph."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _delegation_trust_score(error_rate: float, call_count: int) -> float:
    """D9 — trust in [0,1] from error rate and volume."""
    if call_count <= 0:
        return 1.0
    base = max(0.0, 1.0 - error_rate)
    volume_penalty = min(0.2, call_count / 10_000.0)
    return round(max(0.0, min(1.0, base - volume_penalty)), 3)


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
            for row in rows:
                agent_id = row["agent_id"]
                card = await self._agent_card(org_id, agent_id, dict(row))
                agents.append(card)
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
        client = await self._client()
        open_issues = 0
        open_p0 = 0
        eval_pass_rate: float | None = None
        stumble_count = 0
        drift_flagged = False
        autonomy_mode = "assisted"
        compliance_profile = "standard"
        if client is not None:
            try:
                row = await client.fetchrow(
                    "SELECT COUNT(*) AS n FROM agent_issues "
                    "WHERE org_id = $1 AND agent_id = $2 "
                    "AND status NOT IN ('resolved','ignored')",
                    org_id,
                    agent_id,
                )
                open_issues = int(row["n"]) if row else 0
            except Exception:
                pass
            try:
                row = await client.fetchrow(
                    "SELECT COUNT(*) AS n FROM agent_issues "
                    "WHERE org_id = $1 AND agent_id = $2 "
                    "AND status NOT IN ('resolved','ignored') "
                    "AND severity = 'critical'",
                    org_id,
                    agent_id,
                )
                open_p0 = int(row["n"]) if row else 0
            except Exception:
                pass
            try:
                row = await client.fetchrow(
                    "SELECT AVG(CASE WHEN passed THEN 1.0 ELSE 0.0 END) AS pass_rate "
                    "FROM production_eval_scores "
                    "WHERE org_id = $1 AND agent_id = $2 "
                    "AND scored_at > NOW() - INTERVAL '24 hours'",
                    org_id,
                    agent_id,
                )
                if row and row["pass_rate"] is not None:
                    eval_pass_rate = float(row["pass_rate"])
            except Exception:
                pass
            try:
                row = await client.fetchrow(
                    "SELECT COUNT(*) AS n FROM agent_stumbles "
                    "WHERE org_id = $1 AND agent_id = $2 "
                    "AND detected_at > NOW() - INTERVAL '7 days'",
                    org_id,
                    agent_id,
                )
                stumble_count = int(row["n"]) if row else 0
            except Exception:
                pass
            try:
                row = await client.fetchrow(
                    """
                    SELECT dimensions FROM drift_reports
                    WHERE org_id = $1 AND agent_id = $2
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    org_id,
                    agent_id,
                )
                if row and row.get("dimensions"):
                    dims = row["dimensions"]
                    if isinstance(dims, str):
                        import json as _json

                        dims = _json.loads(dims)
                    drift_flagged = any(
                        bool(d.get("flagged")) for d in (dims or [])
                    )
            except Exception:
                pass

        try:
            from eden.closed_loop.autonomy_policy import resolve

            policy = await resolve(org_id, agent_id)
            autonomy_mode = policy.effective_mode()
            compliance_profile = policy.compliance_profile
        except Exception:
            pass

        slo = registry.get("slo_config") or {}
        if isinstance(slo, str):
            import json

            try:
                slo = json.loads(slo)
            except Exception:
                slo = {}
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

    async def _ensure_registry_from_traces(self, org_id: str) -> None:
        client = await self._client()
        if client is None:
            return
        try:
            rows = await client.fetch(
                """
                SELECT DISTINCT agent_id FROM agent_stumbles
                WHERE org_id = $1 AND agent_id IS NOT NULL
                LIMIT 200
                """,
                org_id,
            )
            for r in rows:
                await self.discover_agent(org_id, r["agent_id"])
        except Exception:
            pass

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None
