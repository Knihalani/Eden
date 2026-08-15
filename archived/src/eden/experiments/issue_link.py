"""F33 — issue-linked production experiments."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


class IssueExperimentWizard:
    """Create and report on experiments linked to agent issues."""

    name = "issue_experiments"

    async def create(
        self,
        org_id: str,
        issue_id: str,
        *,
        control_variant: str,
        treatment_variant: str,
        min_samples: int = 100,
    ) -> dict[str, Any]:
        experiment_id = f"iss-exp-{uuid.uuid4().hex[:12]}"
        link_id = str(uuid.uuid4())
        client = await self._client()
        if client is None:
            return self._err("database unavailable")
        try:
            await client.execute(
                "INSERT INTO issue_experiments "
                "(id, org_id, issue_id, experiment_id, control_variant, "
                "treatment_variant, min_samples_per_variant, status) "
                "VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, 'running')",
                link_id,
                org_id,
                issue_id,
                experiment_id,
                control_variant,
                treatment_variant,
                min_samples,
            )
            await client.execute(
                "UPDATE agent_issues SET experiment_id = $1::uuid "
                "WHERE org_id = $2 AND id = $3::uuid",
                link_id,
                org_id,
                issue_id,
            )
        except Exception as exc:
            logger.warning("issue_experiment.create failed: %s", exc)
            return self._err(str(exc))
        return self._ok(
            {
                "link_id": link_id,
                "experiment_id": experiment_id,
                "issue_id": issue_id,
                "control_variant": control_variant,
                "treatment_variant": treatment_variant,
                "status": "running",
            }
        )

    async def report(self, org_id: str, issue_id: str, link_id: str) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            return self._err("database unavailable")
        try:
            row = await client.fetchrow(
                "SELECT * FROM issue_experiments "
                "WHERE org_id = $1 AND issue_id = $2::uuid AND id = $3::uuid",
                org_id,
                issue_id,
                link_id,
            )
            if row is None:
                return self._err("experiment not found")
            issue = await client.fetchrow(
                "SELECT fingerprint, stumble_count FROM agent_issues "
                "WHERE org_id = $1 AND id = $2::uuid",
                org_id,
                issue_id,
            )
            fp = issue["fingerprint"] if issue else None
            control_rows = await client.fetch(
                """
                SELECT outcome FROM telemetry_events
                WHERE tenant_id = $1
                  AND attributes->>'fingerprint' = $2
                  AND timestamp >= now() - interval '14 days'
                  AND (attributes->>'variant' IS NULL OR attributes->>'variant' = $3)
                LIMIT 500
                """,
                org_id,
                fp,
                row["control_variant"],
            )
            treatment_rows = await client.fetch(
                """
                SELECT outcome FROM telemetry_events
                WHERE tenant_id = $1
                  AND attributes->>'fingerprint' = $2
                  AND timestamp >= now() - interval '14 days'
                  AND attributes->>'variant' = $3
                LIMIT 500
                """,
                org_id,
                fp,
                row["treatment_variant"],
            )
            n_control = len(control_rows or [])
            n_treatment = len(treatment_rows or [])

            def _stumble_rate(rows: list) -> float:
                if not rows:
                    return 0.0
                fails = sum(1 for r in rows if (r.get("outcome") or "") != "success")
                return fails / len(rows)

            control_rate = _stumble_rate(control_rows or [])
            treatment_rate = _stumble_rate(treatment_rows or [])
            control_metrics = [
                1.0 if (r.get("outcome") or "") != "success" else 0.0
                for r in control_rows or []
            ]
            treatment_metrics = [
                1.0 if (r.get("outcome") or "") != "success" else 0.0
                for r in treatment_rows or []
            ]
            try:
                from eden.experiments._common import _prob_treatment_better

                prob_better = (
                    _prob_treatment_better(control_metrics, treatment_metrics)
                    if control_metrics and treatment_metrics
                    else 0.5
                )
            except Exception:
                prob_better = 0.5
            recommendation = (
                "promote_treatment"
                if prob_better > 0.95 and n_control >= row["min_samples_per_variant"]
                else "insufficient_data"
                if n_control < row["min_samples_per_variant"]
                else "continue"
            )
            result = {
                "control_stumble_rate": round(control_rate, 4),
                "treatment_stumble_rate": round(treatment_rate, 4),
                "prob_treatment_better": round(prob_better, 4),
                "n_control": n_control,
                "n_treatment": n_treatment,
                "fingerprint": fp,
                "recommendation": recommendation,
            }
            await client.execute(
                "UPDATE agent_issues SET experiment_result = $1::jsonb "
                "WHERE org_id = $2 AND id = $3::uuid",
                __import__("json").dumps(result),
                org_id,
                issue_id,
            )
            return self._ok(
                {
                    "link_id": str(row["id"]),
                    "experiment_id": row["experiment_id"],
                    "status": row["status"],
                    "report": result,
                }
            )
        except Exception as exc:
            logger.warning("issue_experiment.report failed: %s", exc)
            return self._err(str(exc))

    async def list_for_issue(self, org_id: str, issue_id: str) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                "SELECT * FROM issue_experiments "
                "WHERE org_id = $1 AND issue_id = $2::uuid "
                "ORDER BY started_at DESC",
                org_id,
                issue_id,
            )
            out = []
            for r in rows:
                d = dict(r)
                d["id"] = str(d["id"])
                d["issue_id"] = str(d["issue_id"])
                if d.get("started_at"):
                    d["started_at"] = d["started_at"].isoformat()
                if d.get("ended_at"):
                    d["ended_at"] = d["ended_at"].isoformat()
                out.append(d)
            return out
        except Exception:
            return []

    def _ok(self, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "status": "ok",
            "feature": self.name,
            "data": data,
            "timestamp": datetime.now(UTC).isoformat(),
        }

    def _err(self, message: str) -> dict[str, Any]:
        return {
            "status": "error",
            "feature": self.name,
            "message": message,
            "timestamp": datetime.now(UTC).isoformat(),
        }

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None
