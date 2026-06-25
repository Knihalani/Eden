"""CodebaseKnowledgeGraph — per-repo graph of (code path, telemetry, history).

A per-repo graph of
``(code_path, telemetry_signature, historical_patches_count,
reverted_count, denied_count, edited_count, last_outcome,
last_updated)``.

3 read-paths used by :class:`PatchGenerator`:

1. **same_file_history** — the per-file revert / denial / edit
   rates. The PatchGenerator feeds these as penalties in its
   prompt so a frequently-reverted file gets a different
   strategy than a fresh one.
2. **same_rca_category_history** — same ``rca_category`` prefix
   on ``code_path`` (e.g. ``rate_limiter/*``). Surfaces the
   highest-quality past fix as a 1-shot in-context example.
3. **telemetry_signature_match** — exact-match on the
   ``telemetry_signature`` column. Surfaces prior
   reverted/denied outcomes with the same signature so the
   generator doesn't repeat a known-bad approach.

:meth:`record_outcome` UPSERTs the row's outcome counters in a
single transaction so subsequent reads see fresh counts.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from ._common import _insert_row, _new_id, _ok_envelope, _select_rows

logger = logging.getLogger(__name__)


def _graph_node_id(org_id: str, repo_id: str, code_path: str) -> str:
    """Deterministic ``cgraph_<sha256[:16]>`` id per ``(org, repo, path)``."""
    h = hashlib.sha256(f"{org_id}|{repo_id}|{code_path}".encode()).hexdigest()[:16]
    return f"cgraph_{h}"


# Map outcome → which counter to increment.
_OUTCOME_COUNTER: dict[str, str] = {
    "success": None,            # success doesn't bump a denial counter
    "merged": None,
    "proposed": None,           # proposed bumps historical_patches_count only
    "reverted": "reverted_count",
    "denied": "denied_count",
    "edited": "edited_count",
}


class CodebaseKnowledgeGraph:
    """Per-repo knowledge graph over past patches + telemetry signatures."""

    name = "codebase_knowledge_graph"

    async def record_outcome(
        self,
        org_id: str,
        repo_id: str,
        code_path: str,
        outcome: str,
        rca_category: str = "",
        telemetry_signature: str = "",
    ) -> dict[str, Any]:
        """Record a patch outcome by upserting the graph node row.

        Increments the appropriate counter (``reverted_count``,
        ``denied_count``, or ``edited_count``) on the matching
        ``(org_id, repo_id, code_path)`` row. ``success`` and
        ``merged`` only update ``last_outcome`` + bump
        ``historical_patches_count``.
        """
        node_id = _graph_node_id(org_id, repo_id, code_path)
        counter = _OUTCOME_COUNTER.get(outcome)

        # UPSERT the row (delete-then-insert semantics from the
        # _common helper), preserving the existing counter values.
        existing_rows = await _select_rows(
            org_id,
            "codebase_knowledge_graph",
            where="id = $2",
            params=(node_id,),
            limit=1,
        )
        existing = existing_rows[0] if existing_rows else None

        if existing is None:
            # First time we've seen this code path — insert a fresh row.
            historical = 1
            reverted = 1 if counter == "reverted_count" else 0
            denied = 1 if counter == "denied_count" else 0
            edited = 1 if counter == "edited_count" else 0
            await _insert_row(
                org_id,
                "codebase_knowledge_graph",
                [
                    "id",
                    "repo_id",
                    "code_path",
                    "telemetry_signature",
                    "historical_patches_count",
                    "reverted_count",
                    "denied_count",
                    "edited_count",
                    "last_outcome",
                ],
                [
                    node_id,
                    repo_id,
                    code_path,
                    telemetry_signature,
                    historical,
                    reverted,
                    denied,
                    edited,
                    outcome,
                ],
            )
        else:
            # Update counters in place.
            historical = (existing.get("historical_patches_count") or 0) + 1
            new_reverted = (existing.get("reverted_count") or 0)
            new_denied = (existing.get("denied_count") or 0)
            new_edited = (existing.get("edited_count") or 0)
            if counter == "reverted_count":
                new_reverted += 1
            elif counter == "denied_count":
                new_denied += 1
            elif counter == "edited_count":
                new_edited += 1
            # All 3 counters live in the same row — re-insert
            # the whole row with bumped values (the table has
            # no partial-UPDATE helper; this is the cheapest
            # write path).
            from ._common import _delete_then_insert
            await _delete_then_insert(
                org_id,
                "id",
                node_id,
                "codebase_knowledge_graph",
                [
                    "id",
                    "repo_id",
                    "code_path",
                    "telemetry_signature",
                    "historical_patches_count",
                    "reverted_count",
                    "denied_count",
                    "edited_count",
                    "last_outcome",
                ],
                [
                    node_id,
                    repo_id,
                    code_path,
                    telemetry_signature,
                    historical,
                    new_reverted,
                    new_denied,
                    new_edited,
                    outcome,
                ],
            )

        return {
            "status": "ok",
            "feature": self.name,
            "live": True,
            "trace_id": _new_id("live"),
            "timestamp": None,
            "data": {
                "node_id": node_id,
                "outcome": outcome,
                "code_path": code_path,
                "historical_patches_count": historical,
            },
        }

    async def same_file_history(
        self,
        org_id: str,
        repo_id: str,
        code_path: str,
    ) -> dict[str, Any]:
        """Read-path 1: same-file history. Real — reads the graph row."""
        node_id = _graph_node_id(org_id, repo_id, code_path)
        rows = await _select_rows(
            org_id,
            "codebase_knowledge_graph",
            where="id = $2",
            params=(node_id,),
            limit=1,
        )
        row = rows[0] if rows else None
        if row is None:
            return _ok_envelope(
                self.name,
                {
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
                },
            )
        historical = row.get("historical_patches_count") or 0
        reverted = row.get("reverted_count") or 0
        denied = row.get("denied_count") or 0
        edited = row.get("edited_count") or 0
        return _ok_envelope(
            self.name,
            {
                "node_id": node_id,
                "code_path": code_path,
                "historical_patches_count": historical,
                "reverted_count": reverted,
                "denied_count": denied,
                "edited_count": edited,
                "last_outcome": row.get("last_outcome"),
                "last_updated": row["last_updated"].isoformat()
                if row.get("last_updated") else None,
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
        """Read-path 2: same-RCA-category history.

        Returns up to 5 graph nodes whose ``code_path`` starts
        with the category prefix (e.g. ``rate_limiter/``), sorted
        by most-recent first. The PatchGenerator uses the
        highest-quality of these as a 1-shot in-context example.
        """
        if not rca_category:
            return _ok_envelope(
                self.name,
                {"rca_category": "", "matches": []},
            )
        rows = await _select_rows(
            org_id,
            "codebase_knowledge_graph",
            where="repo_id = $2 AND code_path LIKE $3",
            params=(repo_id, f"{rca_category}/%"),
            order_by="last_updated DESC",
            limit=5,
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
            for r in rows
        ]
        return _ok_envelope(
            self.name,
            {"rca_category": rca_category, "matches": matches},
        )

    async def telemetry_signature_match(
        self,
        org_id: str,
        repo_id: str,
        telemetry_signature: str,
    ) -> dict[str, Any]:
        """Read-path 3: telemetry signature match. Real — reads by signature."""
        if not telemetry_signature:
            return _ok_envelope(
                self.name,
                {"telemetry_signature": "", "matches": []},
            )
        rows = await _select_rows(
            org_id,
            "codebase_knowledge_graph",
            where="repo_id = $2 AND telemetry_signature = $3",
            params=(repo_id, telemetry_signature),
            order_by="last_updated DESC",
            limit=10,
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
            for r in rows
        ]
        return _ok_envelope(
            self.name,
            {"telemetry_signature": telemetry_signature, "matches": matches},
        )
