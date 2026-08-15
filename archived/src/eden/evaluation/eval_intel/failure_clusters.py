"""Failure clustering service (Cat 3) — real implementation.

:class:`FailureClusterer` pulls low-score rows from
``judge_scores`` for the given ``(org_id, judge_name)`` in the
given window, groups them by a deterministic
``(judge_name, agent_id, error_category)`` signature, and
persists the clusters to ``eval_failure_clusters`` (one row
per cluster, delete-then-insert on ``(org_id, judge_name)``
for re-runnability).

The signature is ``f"{judge_name}+{agent_id}+{error_category}"``
where ``agent_id`` and ``error_category`` are best-effort
extractions from the ``judge_scores.rationale`` text and the
``judge_scores.trace_id`` prefix. Defaults to ``"unknown"``
when extraction fails so the signature is always
well-formed.

The :attr:`name` is ``"failure_clusterer"``.

Graceful degradation:

* No ``judge_scores`` rows in the window → returns
  ``{clusters: [], total_failures: 0, message: "no scores"}``.
* No Postgres client → in-memory response, no persistence.
* Single-row cluster → kept (min cluster size = 1; the
  appendix says ≥ 2 but the v1 keeps all clusters so the
  operator can see every signature).

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import defaultdict
from typing import Any

from ._common import (
    FAILURE_CLUSTER_THRESHOLD,
    _bad_request_envelope,
    _delete_then_insert_failure_clusters,
    _fetch_judge_scores_for_window,
    _ok_envelope,
    _parse_window,
)

logger = logging.getLogger(__name__)


# Pattern for extracting ``agent_id=<x>`` and
# ``error_category=<y>`` from a rationale string. Defensive:
# most rationales don't have these, so the default to
# "unknown" is the common case.
_AGENT_RE = re.compile(r"agent(?:_id)?=([a-zA-Z0-9_\-]+)")
_ERROR_CAT_RE = re.compile(
    r"error[_\- ]?category=([a-zA-Z0-9_\-]+)"
)


def _extract_signature(
    *, judge_name: str, trace_id: str, rationale: str
) -> str:
    """Build the deterministic cluster signature.

    The signature is ``{judge_name}+{agent_id}+{error_category}``.
    ``agent_id`` falls back to the first 8 chars of the
    ``trace_id`` (a reasonable proxy when no explicit agent
    id is present), then to ``"unknown"``. ``error_category``
    is regex-extracted from the rationale, then falls back
    to ``"unknown"``.
    """
    agent_id = "unknown"
    if rationale:
        m = _AGENT_RE.search(rationale)
        if m:
            agent_id = m.group(1)
    if agent_id == "unknown" and trace_id:
        # Use the first 8 chars of the trace_id as a stable
        # agent_id proxy.
        agent_id = str(trace_id).split("-", 1)[0][:8] or "unknown"

    error_category = "unknown"
    if rationale:
        m = _ERROR_CAT_RE.search(rationale)
        if m:
            error_category = m.group(1)

    return f"{judge_name}+{agent_id}+{error_category}"


def _stable_hash(*parts: str) -> str:
    """Deterministic SHA-256-based cluster id. Re-runs on the
    same input produce the same id (idempotent)."""
    h = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return f"clu_{h[:16]}"


class FailureClusterer:
    """Group low-score traces by signature for an org + judge.

    Public method :meth:`cluster` returns the live envelope on
    success, or a live "bad_request" envelope on invalid
    window input.
    """

    name = "failure_clusterer"

    async def cluster(
        self,
        org_id: str,
        *,
        judge_name: str,
        window: str = "24h",
    ) -> dict[str, Any]:
        # 1. Validate the window string.
        if not judge_name or not isinstance(judge_name, str):
            return _bad_request_envelope(
                self.name,
                "judge_name must be a non-empty string",
            )
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '24h'",
            )

        # 2. Pull low-score rows.
        rows = await _fetch_judge_scores_for_window(
            org_id, judge_name, interval,
            threshold=FAILURE_CLUSTER_THRESHOLD,
        )
        if not rows:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "judge_name": judge_name,
                    "window": window,
                    "clusters": [],
                    "total_failures": 0,
                    "message": "no scores below threshold in window",
                },
            )

        # 3. Group by signature.
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            sig = _extract_signature(
                judge_name=judge_name,
                trace_id=str(row.get("trace_id", "")),
                rationale=str(row.get("rationale", "") or ""),
            )
            groups[sig].append(row)

        # 4. Build cluster records.
        clusters: list[dict[str, Any]] = []
        persistence_rows: list[dict[str, Any]] = []
        for sig, members in sorted(groups.items()):
            scores = [
                float(m.get("score", 0.0) or 0.0) for m in members
            ]
            sample_score = sum(scores) / len(scores) if scores else 0.0
            # First 3 sample rationales.
            sample_rationales = [
                str(m.get("rationale", ""))[:200]
                for m in members[:3]
                if m.get("rationale")
            ]
            sample_json = json.dumps(sample_rationales)[:4000]
            cluster_id = _stable_hash(judge_name, sig)
            clusters.append(
                {
                    "cluster_id": cluster_id,
                    "signature": sig,
                    "member_count": len(members),
                    "sample_score": round(sample_score, 4),
                    "sample_rationales": sample_rationales,
                }
            )
            persistence_rows.append(
                {
                    "signature": sig,
                    "member_count": len(members),
                    "sample_json": sample_json,
                }
            )

        # 5. Sort by member_count desc, then signature asc
        # (deterministic tiebreak).
        clusters.sort(key=lambda c: (-c["member_count"], c["signature"]))

        # 6. Persist (best-effort, delete-then-insert on
        # (org_id, judge_name) so the service is re-runnable).
        await _delete_then_insert_failure_clusters(
            org_id, judge_name, persistence_rows,
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "judge_name": judge_name,
                "window": window,
                "clusters": clusters,
                "total_failures": len(rows),
                "cluster_count": len(clusters),
                "threshold": FAILURE_CLUSTER_THRESHOLD,
            },
        )
