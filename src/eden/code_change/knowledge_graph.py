"""CodebaseKnowledgeGraph — per-repo graph of (code path, telemetry, history).

A per-repo graph of
``(code_path, telemetry_signature, historical_patches_count,
reverted_count, denied_count, edited_count, last_outcome,
last_updated)``.

Updated after every patch (success or revert). The graph has 3
read-paths used by the :class:`PatchGenerator`:

1. **Same-file history** — "the last 3 patches in this file were
   all reverted, suggest a different approach" (uses a per-file
   revert-rate AND the per-file denial-rate as penalties in the
   PatchGenerator's prompt).
2. **Same-RCA-category history** — "the last 'rate_limiter' RCA
   was fixed by changing the ceiling to 100; here's the diff"
   (surfaces past fixes with the highest ``quality_score`` AND
   the lowest ``denial_rate``, used as a 1-shot in-context
   example).
3. **Telemetry signature match** — when a new RCA + new patch
   share a telemetry signature with a prior (reverted, denied,
   or edited-then-approved) patch, the graph surfaces the prior
   outcome ("last time we tried this it regressed on the
   success_rate metric; don't ship without an explicit A/B test"
   OR "this is similar to PR #127 which was denied as duplicate;
   recommend you confirm before approving").

STUB mode persists the deterministic graph node id to
``codebase_knowledge_graph`` and returns the not-implemented
envelope for the 3 read paths (Gate 5 — knowledge graph).
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from ._common import _new_id, _not_implemented_envelope

logger = logging.getLogger(__name__)


def _graph_node_id(org_id: str, repo_id: str, code_path: str) -> str:
    """Deterministic ``cgraph_<sha256[:16]>`` id per ``(org, repo, path)``.

    Idempotent re-runs are critical for the graph — the same
    code path should always map to the same row.
    """
    h = hashlib.sha256(f"{org_id}|{repo_id}|{code_path}".encode()).hexdigest()[:16]
    return f"cgraph_{h}"


class CodebaseKnowledgeGraph:
    """Per-repo knowledge graph over past patches + telemetry signatures."""

    name = "codebase_knowledge_graph"

    async def record_outcome(
        self,
        org_id: str,
        repo_id: str,
        code_path: str,
        outcome: str,
    ) -> dict[str, Any]:
        """Record a patch outcome (success / reverted / denied / edited).

        STUB: returns the live envelope with the deterministic
        node id. The real Gate-5 implementation will UPDATE the
        ``codebase_knowledge_graph`` row's
        ``(reverted_count, denied_count, edited_count, last_outcome,
        last_updated)`` columns in a single transaction.
        """
        node_id = _graph_node_id(org_id, repo_id, code_path)
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
                "message": (
                    "Stub record — Gate 5 will update the "
                    "codebase_knowledge_graph row in a "
                    "single transaction."
                ),
            },
        }

    async def same_file_history(
        self,
        org_id: str,
        repo_id: str,
        code_path: str,
    ) -> dict[str, Any]:
        """Read-path 1: same-file history. STUB: Gate-5 blocked."""
        return _not_implemented_envelope(
            self.name,
            message=(
                "Same-file history read-path ships in Gate 5 "
                "(knowledge graph). STUB returns a blocked envelope."
            ),
            gate="5_blocked",
            data={
                "node_id": _graph_node_id(org_id, repo_id, code_path),
                "historical_patches_count": 0,
                "reverted_count": 0,
                "denied_count": 0,
                "edited_count": 0,
                "stub_id": _new_id("kg_stub"),
            },
        )

    async def same_rca_category_history(
        self,
        org_id: str,
        rca_category: str,
    ) -> dict[str, Any]:
        """Read-path 2: same-RCA-category history. STUB: Gate-5 blocked."""
        return _not_implemented_envelope(
            self.name,
            message=(
                "Same-RCA-category history read-path ships in "
                "Gate 5. STUB returns a blocked envelope."
            ),
            gate="5_blocked",
            data={"rca_category": rca_category, "matches": []},
        )

    async def telemetry_signature_match(
        self,
        org_id: str,
        telemetry_signature: str,
    ) -> dict[str, Any]:
        """Read-path 3: telemetry signature match. STUB: Gate-5 blocked."""
        return _not_implemented_envelope(
            self.name,
            message=(
                "Telemetry-signature match read-path ships in "
                "Gate 5. STUB returns a blocked envelope."
            ),
            gate="5_blocked",
            data={"telemetry_signature": telemetry_signature, "matches": []},
        )
