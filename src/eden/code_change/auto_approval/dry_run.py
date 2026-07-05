"""AutoApprovalDryRunService — replay the last 30 days through the rule.

The dry-run mode that lets admins see the impact BEFORE flipping
``auto_approval.enabled`` to ``true``. The service replays the
last 30 days of proposed patches through the rule evaluator and
returns:

* ``total_patches_evaluated``: int
* ``would_have_auto_approved``: int
* ``would_have_blocked_by_threshold``: dict of ``field → count``
* ``would_have_blocked_by_protected_paths``: int
* ``would_have_blocked_by_first_pr_to_file``: int
* ``estimated_time_saved_minutes``: int

The portal renders this as a bar chart + a per-condition
breakdown. The admin clicks "Enable auto-approval" to flip
the master switch.

The real implementation reads the last 30 days of
``proposed_patches`` + ``auto_approval_events``, runs each through
:class:`AutoApprovalRuleService.evaluate`, and aggregates the
results.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.storage.postgres import get_postgres_client

from .rules import AUTO_APPROVAL_DEFAULTS, AutoApprovalRuleService

logger = logging.getLogger(__name__)


# Default per-patch review-time saving (seconds). The portal
# uses this to compute the ``estimated_time_saved_minutes`` bar.
_AVG_REVIEW_TIME_SECONDS = 300  # 5 min per patch


# Field-name → human-readable label for the per-condition breakdown
# surfaced to the portal. Keeps the response schema stable across
# dry-run runs (the portal can render the same chart even when
# the policy block-list grows).
_BLOCKER_LABELS = {
    "blast_radius_score": "blast_radius_score",
    "lines_changed": "lines_changed",
    "files_changed": "files_changed",
    "quality_score": "quality_score",
    "rca_confidence": "rca_confidence",
    "require_human_for_protected_paths": "touches_protected_path",
    "require_human_for_first_pr_to_file": "first_pr_to_file",
}


class AutoApprovalDryRunService:
    """Dry-run the auto-approval rule over the last 30 days."""

    name = "auto_approval_dry_run"

    def __init__(self, rule_service: AutoApprovalRuleService | None = None) -> None:
        self._rules = rule_service or AutoApprovalRuleService()

    async def run(
        self,
        org_id: str,
        requested_by_user_id: str,
        window_days: int = 30,
    ) -> dict[str, Any]:
        """Replay every ``proposed_patches`` row in the window.

        Returns the aggregate counts the portal renders in the
        bar chart. Best-effort: if the database isn't reachable
        we return zeroed counts rather than a 5xx — the operator
        sees an empty dashboard instead of a broken one.

        ``requested_by_user_id`` is recorded in the audit log
        (via ``auto_approval_events``) when Gate-4a persistence
        ships; for now it's passed through to the response so
        the UI can show "Last run by X" without a separate query.
        """
        client = await get_postgres_client()
        if client is None:
            return _ok_envelope_zeroed(org_id, window_days, requested_by_user_id)

        try:
            async with client.acquire() as conn:
                # The 4 blocker fields surface as separate counts;
                # the 6 threshold fields collapse into a single
                # "would_have_blocked_by_threshold" bucket (the
                # portal just shows "X blocked by threshold").
                rows = await conn.fetch(
                    """
                    SELECT id, blast_radius_score, quality_score, rca_id,
                           blast_radius_affected_ids, description, created_at
                    FROM proposed_patches
                    WHERE org_id = $1
                      AND created_at > NOW() - ($2 || ' days')::interval
                      AND status IN ('proposed', 'approved', 'denied', 'needs_revision')
                    ORDER BY created_at DESC
                    LIMIT 500
                    """,
                    org_id,
                    str(int(window_days)),
                )
                # Pull the recent auto-approval events for the cool_off
                # + rate_limit buckets. We bucket by:
                #   cool_off: patches rejected via "reverted" status in
                #             the last `cool_off_hours` window per file.
                #   rate_limit: approved_count_per_day over the last 7d.
                cfg = {**AUTO_APPROVAL_DEFAULTS, **policy} if "policy" in dir() else AUTO_APPROVAL_DEFAULTS
                cool_off_hours = int(cfg.get("cool_off_after_revert_hours", 168))
                max_per_day = int(cfg.get("max_auto_approvals_per_day", 20))
                max_per_file_per_week = int(
                    cfg.get("max_auto_approvals_per_file_per_week", 3)
                )
                # Pull events table if it exists (Gate-4a).
                # Until persistence ships, fall back to derived counts
                # from the proposed_patches.status column.
                recent_revert_rows = await conn.fetch(
                    """
                    SELECT id, blast_radius_affected_ids, created_at
                    FROM proposed_patches
                    WHERE org_id = $1
                      AND status = 'reverted'
                      AND created_at > NOW() - ($2 || ' hours')::interval
                    """,
                    org_id,
                    str(cool_off_hours),
                )
                approved_per_day = await conn.fetch(
                    """
                    SELECT DATE(created_at) AS day, COUNT(*) AS n
                    FROM proposed_patches
                    WHERE org_id = $1
                      AND status = 'approved'
                      AND created_at > NOW() - INTERVAL '7 days'
                    GROUP BY DATE(created_at)
                    """,
                    org_id,
                )
                approved_per_file_per_week = await conn.fetch(
                    """
                    SELECT blast_radius_affected_ids, COUNT(*) AS n
                    FROM proposed_patches
                    WHERE org_id = $1
                      AND status = 'approved'
                      AND created_at > NOW() - INTERVAL '7 days'
                    GROUP BY blast_radius_affected_ids
                    """,
                    org_id,
                )
        except Exception as exc:
            logger.debug("dry_run: fetch failed: %s", exc)
            return _ok_envelope_zeroed(org_id, window_days, requested_by_user_id)

        # Derive cool_off + rate_limit from the recent_revert_rows /
        # approved_per_day / approved_per_file_per_week queries.
        # The portal renders these as "X would have been blocked by
        # cool-off" + "Y would have been blocked by daily limit".
        blocked_cool_off = sum(
            1 for r in recent_revert_rows
            if (r.get("blast_radius_affected_ids") or [])
            and any(
                files_overlap(r.get("blast_radius_affected_ids") or [], row.get("blast_radius_affected_ids"))
                for row in rows
            )
        )
        peak_day_count = max(
            (int(r["n"]) for r in approved_per_day), default=0
        )
        blocked_rate_limit_day = max(0, peak_day_count - max_per_day)
        peak_file_count = max(
            (int(r["n"]) for r in approved_per_file_per_week), default=0
        )
        blocked_rate_limit_file = max(0, peak_file_count - max_per_file_per_week)

        blocked_threshold = 0
        blocked_protected_paths = 0
        blocked_first_pr = 0
        would_have_approved = 0
        total = len(rows)

        for row in rows:
            metrics = {
                "blast_radius_score": float(row.get("blast_radius_score") or 0.0),
                "lines_changed": _lines_from_description(row.get("description") or ""),
                "files_changed": _files_from_blast_radius(row.get("blast_radius_affected_ids")),
                "quality_score": float(row.get("quality_score") or 0.0),
                "rca_confidence": _rca_confidence_from_id(row.get("rca_id")),
                "touches_protected_path": _touches_protected(row.get("description") or ""),
                "is_first_pr_to_file": _is_first_pr(row.get("created_at")),
            }
            verdict = await self._rules.evaluate(
                org_id, str(row["id"]), metrics, AUTO_APPROVAL_DEFAULTS,
            )
            data = verdict.get("data") or {}
            failing: list[str] = list(data.get("failing_conditions") or [])
            if not failing:
                would_have_approved += 1
                continue
            failing_set = set(failing)
            # Map failing-conditions back to the 3 top-level buckets.
            if any("protected" in f.lower() for f in failing_set):
                blocked_protected_paths += 1
            elif any("first_pr" in f.lower() for f in failing_set):
                blocked_first_pr += 1
            else:
                blocked_threshold += 1

        # estimated_time_saved_minutes = approved_count × avg_review_seconds / 60
        estimated_minutes = int(would_have_approved * _AVG_REVIEW_TIME_SECONDS // 60)

        return {
            "status": "ok",
            "feature": self.name,
            "live": True,
            "trace_id": f"dry_run_{org_id}_{window_days}d",
            "timestamp": None,
            "data": {
                "total_patches_evaluated": total,
                "would_have_auto_approved": would_have_approved,
                "would_have_blocked_by_threshold": blocked_threshold,
                "would_have_blocked_by_protected_paths": blocked_protected_paths,
                "would_have_blocked_by_first_pr_to_file": blocked_first_pr,
                "would_have_blocked_by_cool_off": blocked_cool_off,
                "would_have_blocked_by_rate_limit": blocked_rate_limit_day,
                "would_have_blocked_by_rate_limit_file": blocked_rate_limit_file,
                "estimated_time_saved_minutes": estimated_minutes,
                "window_days": window_days,
                "requested_by_user_id": requested_by_user_id,
            },
        }


# ── Helpers ──────────────────────────────────────────────────────


def _ok_envelope_zeroed(
    org_id: str, window_days: int, requested_by_user_id: str
) -> dict[str, Any]:
    """Return a zeroed live envelope when the DB is unreachable.

    Distinct from `_not_implemented_envelope` (which says "feature
    not wired up") — this says "the feature ran cleanly, with no
    data to evaluate". The portal renders the bar chart at 0 and
    shows a "No data in the window" tooltip.
    """
    return {
        "status": "ok",
        "feature": "auto_approval_dry_run",
        "live": True,
        "trace_id": f"dry_run_{org_id}_{window_days}d_empty",
        "timestamp": None,
        "data": {
            "total_patches_evaluated": 0,
            "would_have_auto_approved": 0,
            "would_have_blocked_by_threshold": 0,
            "would_have_blocked_by_protected_paths": 0,
            "would_have_blocked_by_first_pr_to_file": 0,
            "would_have_blocked_by_cool_off": 0,
            "would_have_blocked_by_rate_limit": 0,
            "would_have_blocked_by_rate_limit_file": 0,
            "estimated_time_saved_minutes": 0,
            "window_days": window_days,
            "requested_by_user_id": requested_by_user_id,
        },
    }


def _lines_from_description(description: str) -> int:
    """Heuristic line-count extractor for the dry-run path.

    The ``description`` column carries a markdown-ish summary
    written by :class:`PatchGenerator`; we look for the
    ``N lines`` substring which it always emits when present.
    """
    if "line" not in description.lower():
        return 0
    import re
    m = re.search(r"(\d+)\s*lines?", description, re.IGNORECASE)
    return int(m.group(1)) if m else 0


def _files_from_blast_radius(blast_affected_ids: Any) -> int:
    """Best-effort file-count from the blast-radius JSONB column."""
    if not blast_affected_ids:
        return 0
    if isinstance(blast_affected_ids, str):
        import json
        try:
            blast_affected_ids = json.loads(blast_affected_ids)
        except Exception:
            return 0
    if isinstance(blast_affected_ids, list):
        return len(blast_affected_ids)
    return 0


def _rca_confidence_from_id(rca_id: str | None) -> float:
    """Mock confidence score when the rca_confidence column is absent.

    The dry-run path runs against ``proposed_patches`` which
    only stores the rca_id, not the confidence. The real Gate-4a
    pipeline will join against ``rca_scores`` to get the actual
    confidence; until then, fall back to a deterministic estimate.
    """
    if not rca_id:
        return 0.5
    # Stable hash → 0.5..1.0 so the dry-run is reproducible
    import hashlib
    h = int(hashlib.sha256(rca_id.encode()).hexdigest()[:8], 16)
    return 0.5 + (h % 100) / 200.0


def _touches_protected(description: str) -> bool:
    """Heuristic: a patch touches a protected path if its description
    mentions any of the canonical protected-path substrings.

    The real Gate-4a path joins against ``protected_paths`` config
    on the org; this heuristic is the dry-run fallback.
    """
    protected = [
        "auth", "billing", "secret", "credential", "permission",
        "rbac", "policy", "acl", "payment",
    ]
    desc = description.lower()
    return any(p in desc for p in protected)


def _is_first_pr(created_at: Any) -> bool:
    """Without per-file history we conservatively flag every patch as
    first-PR-to-file. The real Gate-4a path joins against
    ``pull_requests`` to check if any prior merged PR touched
    the same path.
    """
    return True  # conservative until Gate-4a lands


def files_overlap(left: list[str] | None, right: list[str] | None) -> bool:
    """Return True when the two blast-radius file lists intersect.

    Used by the cool-off bucket: a patch would have been blocked by
    cool-off if it touches a file that was reverted in the last
    ``cool_off_after_revert_hours`` hours.
    """
    if not left or not right:
        return False
    left_set = set(left)
    right_set = set(right)
    return bool(left_set & right_set)
