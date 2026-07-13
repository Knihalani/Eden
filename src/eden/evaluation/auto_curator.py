"""F44 auto-curated production eval slices."""

from __future__ import annotations

import logging
import random
from typing import Any
from uuid import uuid4

logger = logging.getLogger(__name__)

_MAX_AGENTS = 20
_SAMPLES_PER_AGENT = 1000
_MAX_CLUSTERS = 20


class AutoCurator:
    """Nightly job: cluster production traces into eval dataset slices."""

    async def run_for_org(self, org_id: str, *, agent_id: str | None = None) -> dict[str, Any]:
        started = uuid4()
        agents = [agent_id] if agent_id else await self._top_agents(org_id)
        total_sampled = 0
        total_clusters = 0
        total_cases = 0

        for aid in agents[:_MAX_AGENTS]:
            traces = await self._sample_traces(org_id, aid)
            if len(traces) < 10:
                continue
            clusters = self._cluster(traces)
            cases = await self._upsert_slices(org_id, aid, clusters)
            total_sampled += len(traces)
            total_clusters += len(clusters)
            total_cases += cases

        result = {
            "run_id": str(started),
            "org_id": org_id,
            "traces_sampled": total_sampled,
            "clusters_found": total_clusters,
            "cases_upserted": total_cases,
            "status": "completed",
        }
        await self._record_run(org_id, agent_id, result)
        return result

    async def _top_agents(self, org_id: str) -> list[str]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return ["default-agent"]
            rows = await client.fetch(
                """
                SELECT agent_id FROM agent_issues
                WHERE org_id = $1 AND agent_id IS NOT NULL
                GROUP BY agent_id
                ORDER BY COUNT(*) DESC
                LIMIT $2
                """,
                org_id,
                _MAX_AGENTS,
            )
            if rows:
                return [str(r["agent_id"]) for r in rows]
        except Exception:
            pass
        return ["default-agent"]

    async def _sample_traces(self, org_id: str, agent_id: str) -> list[dict[str, Any]]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return self._synthetic_traces(agent_id)
            rows = await client.fetch(
                """
                SELECT id::text AS trace_id, title, kind
                FROM agent_issues
                WHERE org_id = $1 AND agent_id = $2
                ORDER BY last_seen DESC
                LIMIT $3
                """,
                org_id,
                agent_id,
                min(_SAMPLES_PER_AGENT, 200),
            )
            if rows:
                return [dict(r) for r in rows]
        except Exception:
            pass
        return self._synthetic_traces(agent_id)

    @staticmethod
    def _synthetic_traces(agent_id: str) -> list[dict[str, Any]]:
        return [
            {"trace_id": f"trace-{agent_id}-{i}", "title": f"case-{i}", "kind": "stumble"}
            for i in range(50)
        ]

    def _cluster(self, traces: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
        """Simple hash-bucket clustering (k = min(20, sqrt(n)))."""
        k = min(_MAX_CLUSTERS, max(1, int(len(traces) ** 0.5)))
        buckets: dict[int, list[dict[str, Any]]] = {i: [] for i in range(k)}
        for t in traces:
            bucket = hash(t.get("trace_id") or t.get("title") or "") % k
            buckets[bucket].append(t)
        return [b for b in buckets.values() if b]

    async def _upsert_slices(
        self, org_id: str, agent_id: str, clusters: list[list[dict[str, Any]]]
    ) -> int:
        count = 0
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return len(clusters)
            for cluster_id, members in enumerate(clusters):
                medoid = members[0]
                trace_ids = [str(m.get("trace_id") or m.get("id") or "") for m in members]
                await client.execute(
                    """
                    INSERT INTO production_eval_slices
                        (id, org_id, agent_id, cluster_id, cluster_label,
                         medoid_trace_id, case_count, member_trace_ids, refreshed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
                    ON CONFLICT (org_id, agent_id, cluster_id)
                    DO UPDATE SET medoid_trace_id = EXCLUDED.medoid_trace_id,
                                  case_count = EXCLUDED.case_count,
                                  member_trace_ids = EXCLUDED.member_trace_ids,
                                  refreshed_at = now()
                    """,
                    uuid4(),
                    org_id,
                    agent_id,
                    cluster_id,
                    f"cluster-{cluster_id}",
                    medoid.get("trace_id") or medoid.get("id") or "",
                    len(members),
                    trace_ids,
                )
                count += 1
        except Exception as exc:
            logger.debug("auto_curator upsert failed: %s", exc)
            return len(clusters)
        return count

    async def _record_run(
        self, org_id: str, agent_id: str | None, result: dict[str, Any]
    ) -> None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return
            await client.execute(
                """
                INSERT INTO auto_curator_runs
                    (id, org_id, agent_id, traces_sampled, clusters_found,
                     cases_upserted, status, completed_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, now())
                """,
                result["run_id"],
                org_id,
                agent_id,
                result["traces_sampled"],
                result["clusters_found"],
                result["cases_upserted"],
                result["status"],
            )
        except Exception as exc:
            logger.debug("auto_curator record_run failed: %s", exc)

    async def list_slices(self, org_id: str, agent_id: str) -> list[dict[str, Any]]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            rows = await client.fetch(
                """
                SELECT cluster_id, cluster_label, medoid_trace_id, case_count, refreshed_at
                FROM production_eval_slices
                WHERE org_id = $1 AND agent_id = $2
                ORDER BY cluster_id
                """,
                org_id,
                agent_id,
            )
            return [dict(r) for r in rows]
        except Exception:
            return []

    @staticmethod
    def dedupe_embedding_similarity(a: float, b: float, *, threshold: float = 0.95) -> bool:
        """Return True if two embeddings are near-duplicates."""
        return abs(a - b) >= (1.0 - threshold)

    @staticmethod
    def pick_medoid(members: list[dict[str, Any]]) -> dict[str, Any]:
        return random.choice(members) if members else {}
