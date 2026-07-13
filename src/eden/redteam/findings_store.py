"""Red-team findings persistence (Phase L).

Thin read/write layer over ``redteam_findings``. The probe runner
calls :meth:`FindingsStore.insert` after each attack prompt; the
dashboard list route reads via :meth:`FindingsStore.list_for_org`.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.redteam.probes import ProbeFinding

logger = logging.getLogger(__name__)


class FindingsStore:
    """Org-scoped CRUD for ``redteam_findings`` rows."""

    def __init__(self, pg: Any) -> None:
        self._pg = pg

    async def insert(self, org_id: str, finding: ProbeFinding) -> None:
        try:
            await self._pg.execute(
                """
                INSERT INTO redteam_findings (
                    id, org_id, probe_name, category, severity,
                    attack_prompt, agent_response, failed,
                    detection_reason, target_label, tags, created_at
                ) VALUES (
                    $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz
                )
                ON CONFLICT (id) DO NOTHING
                """,
                finding.id,
                org_id,
                finding.probe_name,
                finding.category,
                finding.severity,
                finding.attack_prompt,
                finding.agent_response,
                finding.failed,
                finding.detection_reason,
                finding.target_label,
                finding.tags,
                finding.created_at,
            )
        except Exception as exc:
            logger.debug("findings_store.insert failed: %s", exc)

    async def list_for_org(
        self,
        org_id: str,
        *,
        limit: int = 50,
        offset: int = 0,
        only_failures: bool = False,
        severity: str | None = None,
        probe_name: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["org_id = $1::uuid"]
        args: list[Any] = [org_id]
        idx = 2

        if only_failures:
            clauses.append("failed = TRUE")
        if severity:
            clauses.append(f"severity = ${idx}")
            args.append(severity)
            idx += 1
        if probe_name:
            clauses.append(f"probe_name = ${idx}")
            args.append(probe_name)
            idx += 1

        where = " AND ".join(clauses)
        try:
            count_row = await self._pg.fetchrow(
                f"SELECT COUNT(*)::bigint AS n FROM redteam_findings WHERE {where}",
                *args,
            )
            total = int(count_row["n"]) if count_row else 0
            rows = await self._pg.fetch(
                f"""
                SELECT id, probe_name, category, severity, attack_prompt,
                       agent_response, failed, detection_reason,
                       target_label, tags, created_at
                FROM redteam_findings
                WHERE {where}
                ORDER BY created_at DESC
                LIMIT ${idx} OFFSET ${idx + 1}
                """,
                *args,
                limit,
                offset,
            )
        except Exception as exc:
            logger.debug("findings_store.list_for_org failed: %s", exc)
            return [], 0

        out: list[dict[str, Any]] = []
        for row in rows:
            out.append({
                "id": str(row["id"]),
                "probe_name": row["probe_name"],
                "category": row["category"],
                "severity": row["severity"],
                "attack_prompt": row["attack_prompt"],
                "agent_response": row["agent_response"],
                "failed": bool(row["failed"]),
                "detection_reason": row["detection_reason"],
                "target_label": row["target_label"],
                "tags": list(row["tags"] or []),
                "created_at": (
                    row["created_at"].isoformat()
                    if hasattr(row["created_at"], "isoformat")
                    else str(row["created_at"])
                ),
            })
        return out, total


__all__ = ["FindingsStore"]
