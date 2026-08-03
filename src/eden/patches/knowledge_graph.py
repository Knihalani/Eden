"""CodebaseKnowledgeGraph — per-repo graph of (code path, telemetry, history).

M13 (§6.3): thin rebuild after Cat-23 bloat cut. Table
``codebase_knowledge_graph`` (migration 027) stores one node per
``(org, repo, path)``. PatchGenerator loads same-file / same-RCA
penalties; N23 plan outcomes (merged / reverted / rejected) write
here so generation priors compound.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _graph_node_id(org_id: str, repo_id: str, code_path: str) -> str:
    """Deterministic ``cgraph_<sha256[:16]>`` id per ``(org, repo, path)``."""
    h = hashlib.sha256(f"{org_id}|{repo_id}|{code_path}".encode()).hexdigest()[:16]
    return f"cgraph_{h}"


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": f"live_{hashlib.sha256(feature.encode()).hexdigest()[:8]}",
        "timestamp": None,
        "data": data,
    }


# Map outcome → which counter to increment. ``merged`` / ``success`` /
# ``proposed`` only bump historical_patches_count + last_outcome.
_OUTCOME_COUNTER: dict[str, str | None] = {
    "success": None,
    "merged": None,
    "proposed": None,
    "reverted": "reverted_count",
    "denied": "denied_count",
    # M13 (§6.3): PR closed-unmerged → rejected (denied_count penalty).
    "rejected": "denied_count",
    "edited": "edited_count",
}


class CodebaseKnowledgeGraph:
    """Per-repo knowledge graph over past patches + telemetry signatures."""

    name = "codebase_knowledge_graph"

    async def record_outcome(
        self,
        org_id: str,
        repo_id: str = "",
        code_path: str = "",
        outcome: str = "",
        rca_category: str = "",
        telemetry_signature: str = "",
        *,
        repo: str | None = None,
        path: str | None = None,
    ) -> dict[str, Any]:
        """Record a patch outcome by upserting the graph node row.

        Accepts both the legacy ``(repo_id, code_path)`` kwargs and the
        M13 aliases ``repo`` / ``path``. Increments the appropriate
        counter on the matching ``(org_id, repo_id, code_path)`` row.
        """
        _ = rca_category  # reserved for same_rca_category_history reads
        repo_id = (repo or repo_id or "").strip()
        code_path = (path or code_path or "").strip()
        if not org_id or not repo_id or not code_path or not outcome:
            return _ok_envelope(
                self.name,
                {"skipped": True, "reason": "missing_keys"},
            )

        node_id = _graph_node_id(org_id, repo_id, code_path)
        counter = _OUTCOME_COUNTER.get(outcome)
        bump_reverted = 1 if counter == "reverted_count" else 0
        bump_denied = 1 if counter == "denied_count" else 0
        bump_edited = 1 if counter == "edited_count" else 0

        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return _ok_envelope(
                    self.name,
                    {"skipped": True, "reason": "no_postgres", "node_id": node_id},
                )
            await client.execute(
                """
                INSERT INTO codebase_knowledge_graph (
                    id, org_id, repo_id, code_path, telemetry_signature,
                    historical_patches_count, reverted_count, denied_count,
                    edited_count, last_outcome, last_updated
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    1, $6, $7, $8, $9, NOW()
                )
                ON CONFLICT (id) DO UPDATE SET
                    historical_patches_count =
                        codebase_knowledge_graph.historical_patches_count + 1,
                    reverted_count =
                        codebase_knowledge_graph.reverted_count + $6,
                    denied_count =
                        codebase_knowledge_graph.denied_count + $7,
                    edited_count =
                        codebase_knowledge_graph.edited_count + $8,
                    last_outcome = $9,
                    telemetry_signature = CASE
                        WHEN $5 = '' THEN codebase_knowledge_graph.telemetry_signature
                        ELSE $5
                    END,
                    last_updated = NOW()
                """,
                node_id,
                org_id,
                repo_id,
                code_path,
                telemetry_signature or "",
                bump_reverted,
                bump_denied,
                bump_edited,
                outcome,
            )
            row = await client.fetchrow(
                "SELECT historical_patches_count FROM codebase_knowledge_graph "
                "WHERE id = $1 AND org_id = $2",
                node_id,
                org_id,
            )
            historical = int((row or {}).get("historical_patches_count") or 1)
        except Exception as exc:
            logger.debug("CodebaseKnowledgeGraph.record_outcome failed: %s", exc)
            return _ok_envelope(
                self.name,
                {"skipped": True, "reason": str(exc)[:200], "node_id": node_id},
            )

        return _ok_envelope(
            self.name,
            {
                "node_id": node_id,
                "outcome": outcome,
                "code_path": code_path,
                "historical_patches_count": historical,
            },
        )

    async def same_file_history(
        self,
        org_id: str,
        repo_id: str,
        code_path: str,
    ) -> dict[str, Any]:
        """Read-path 1: same-file history (revert / denial rates)."""
        node_id = _graph_node_id(org_id, repo_id, code_path)
        empty = {
            "node_id": node_id,
            "code_path": code_path,
            "historical_patches_count": 0,
            "reverted_count": 0,
            "denied_count": 0,
            "edited_count": 0,
            "last_outcome": None,
            "revert_rate": 0.0,
            "denial_rate": 0.0,
            "found": False,
        }
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return _ok_envelope(self.name, empty)
            row = await client.fetchrow(
                "SELECT * FROM codebase_knowledge_graph "
                "WHERE id = $1 AND org_id = $2",
                node_id,
                org_id,
            )
        except Exception as exc:
            logger.debug("same_file_history failed: %s", exc)
            return _ok_envelope(self.name, empty)
        if row is None:
            return _ok_envelope(self.name, empty)
        r = dict(row)
        historical = r.get("historical_patches_count") or 0
        reverted = r.get("reverted_count") or 0
        denied = r.get("denied_count") or 0
        edited = r.get("edited_count") or 0
        return _ok_envelope(
            self.name,
            {
                "node_id": node_id,
                "code_path": code_path,
                "historical_patches_count": historical,
                "reverted_count": reverted,
                "denied_count": denied,
                "edited_count": edited,
                "last_outcome": r.get("last_outcome"),
                "last_updated": r["last_updated"].isoformat()
                if r.get("last_updated")
                else None,
                "revert_rate": (reverted / historical) if historical else 0.0,
                "denial_rate": (denied / historical) if historical else 0.0,
                "found": True,
            },
        )

    async def same_rca_category_history(
        self,
        org_id: str,
        repo_id: str,
        rca_category: str,
    ) -> dict[str, Any]:
        """Read-path 2: same-RCA-category history (prefix match)."""
        if not rca_category:
            return _ok_envelope(self.name, {"rca_category": "", "matches": []})
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return _ok_envelope(
                    self.name, {"rca_category": rca_category, "matches": []}
                )
            rows = await client.fetch(
                """
                SELECT id, code_path, last_outcome, historical_patches_count,
                       reverted_count
                FROM codebase_knowledge_graph
                WHERE org_id = $1 AND repo_id = $2 AND code_path LIKE $3
                ORDER BY last_updated DESC
                LIMIT 5
                """,
                org_id,
                repo_id,
                f"{rca_category}/%",
            )
        except Exception as exc:
            logger.debug("same_rca_category_history failed: %s", exc)
            return _ok_envelope(
                self.name, {"rca_category": rca_category, "matches": []}
            )
        matches = [
            {
                "node_id": r["id"],
                "code_path": r["code_path"],
                "last_outcome": r.get("last_outcome"),
                "historical_patches_count": r.get("historical_patches_count") or 0,
                "revert_rate": (
                    (r.get("reverted_count") or 0)
                    / max(1, r.get("historical_patches_count") or 0)
                ),
            }
            for r in (rows or [])
        ]
        return _ok_envelope(
            self.name, {"rca_category": rca_category, "matches": matches}
        )

    async def telemetry_signature_match(
        self,
        org_id: str,
        repo_id: str,
        telemetry_signature: str,
    ) -> dict[str, Any]:
        """Read-path 3: exact telemetry signature match."""
        if not telemetry_signature:
            return _ok_envelope(
                self.name, {"telemetry_signature": "", "matches": []}
            )
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return _ok_envelope(
                    self.name,
                    {"telemetry_signature": telemetry_signature, "matches": []},
                )
            rows = await client.fetch(
                """
                SELECT id, code_path, last_outcome, historical_patches_count,
                       reverted_count
                FROM codebase_knowledge_graph
                WHERE org_id = $1 AND repo_id = $2 AND telemetry_signature = $3
                ORDER BY last_updated DESC
                LIMIT 10
                """,
                org_id,
                repo_id,
                telemetry_signature,
            )
        except Exception as exc:
            logger.debug("telemetry_signature_match failed: %s", exc)
            return _ok_envelope(
                self.name,
                {"telemetry_signature": telemetry_signature, "matches": []},
            )
        matches = [
            {
                "node_id": r["id"],
                "code_path": r["code_path"],
                "last_outcome": r.get("last_outcome"),
                "historical_patches_count": r.get("historical_patches_count") or 0,
                "revert_rate": (
                    (r.get("reverted_count") or 0)
                    / max(1, r.get("historical_patches_count") or 0)
                ),
            }
            for r in (rows or [])
        ]
        return _ok_envelope(
            self.name,
            {"telemetry_signature": telemetry_signature, "matches": matches},
        )

    async def revert_risk_premium(
        self,
        org_id: str,
        repo_id: str,
        paths: list[str],
    ) -> float:
        """M13 (§6.1): KG revert-risk premium for EV fix-cost.

        Returns a USD-ish additive premium based on max revert_rate
        across ``paths`` (0.0 when unknown / empty). Cap: $2.00.
        """
        if not paths or not org_id or not repo_id:
            return 0.0
        max_rate = 0.0
        for path in paths[:8]:
            if not path:
                continue
            try:
                hist = await self.same_file_history(org_id, repo_id, path)
                data = hist.get("data") or {}
                max_rate = max(max_rate, float(data.get("revert_rate") or 0.0))
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("kg revert_risk_premium failed: %s", exc)
        return round(max_rate * 2.0, 4)


async def record_plan_outcome(
    org_id: str,
    plan: dict[str, Any],
    outcome: str,
) -> int:
    """M13 (§6.3): best-effort KG writes for every file a plan touched.

    Returns the number of paths recorded. Never raises.
    """
    try:
        files = plan.get("files_changed") or []
        paths: list[str] = []
        for f in files:
            if isinstance(f, str) and f:
                paths.append(f)
            elif isinstance(f, dict):
                p = f.get("path") or f.get("file")
                if isinstance(p, str) and p:
                    paths.append(p)
        if not paths:
            fp = str(plan.get("source_fingerprint") or "").strip()
            if fp:
                paths = [fp]
        if not paths:
            return 0

        repo_id = (
            str(plan.get("agent_id") or "").strip()
            or str((plan.get("evidence") or {}).get("repo_id") or "").strip()
            or "default"
        )
        kg = CodebaseKnowledgeGraph()
        recorded = 0
        for path in paths[:10]:
            await kg.record_outcome(
                org_id=org_id,
                repo_id=repo_id,
                code_path=path,
                outcome=outcome,
            )
            recorded += 1
        return recorded
    except Exception as exc:
        logger.debug("record_plan_outcome failed: %s", exc)
        return 0


__all__ = [
    "CodebaseKnowledgeGraph",
    "record_plan_outcome",
]
