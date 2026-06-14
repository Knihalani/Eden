"""CodeChangePolicyService — per-tenant + per-repo opt-in policy.

The policy is the v1.6 Cat 23 two-stage opt-in (mirrors the
v1.4 LLM-as-judge opt-in policy):

1. ``code_change_enabled`` — the master switch. Defaults to
   ``false`` for every tenant.
2. ``auto_pr_enabled`` / ``auto_revert_enabled`` — the
   auto-mode opt-ins. Both default to ``false``.

The full policy schema (per the v1.6 cat spec) is captured in
``DEFAULT_POLICY`` in ``_common.py`` and includes the
``max_blast_radius_score``, ``min_rca_confidence``,
``min_test_pass_rate``, ``min_quality_score``,
``protected_paths``, ``protected_branch_patterns``,
``min_post_merge_window_hours``, ``revert_threshold_pct``,
``max_patches_per_day``, ``max_cost_per_patch_usd``, and
``required_reviewers`` fields.

STUB mode persists the policy to ``organizations.features.
code_change_policy`` and returns the live envelope. The real
implementation (Gate 4a) will additionally enforce the
``protected_paths`` and ``protected_branch_patterns`` globs
across the blast-radius analyzer and the PR creator.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import DEFAULT_POLICY, _json_dumps, _new_id, _ok_envelope

logger = logging.getLogger(__name__)


class CodeChangePolicyService:
    """Per-tenant + per-repo Cat 23 opt-in policy."""

    name = "code_change_policy"

    async def get(self, org_id: str) -> dict[str, Any]:
        """Return the current policy. STUB: returns the defaults."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "policy": dict(DEFAULT_POLICY),
                "message": (
                    "Stub policy — defaults returned. Gate 4a will "
                    "read from organizations.features.code_change_policy."
                ),
            },
        )

    async def update(self, org_id: str, policy: dict[str, Any]) -> dict[str, Any]:
        """Update the policy. STUB: validates and returns the live envelope.

        Validates the two-stage opt-in fields are present. The
        destructive fields (``max_blast_radius_score``,
        ``min_test_pass_rate``, etc.) are validated as 0-1 / 0-100
        percentages but the real Gate-4a implementation will also
        enforce the per-field cap ceilings.
        """
        merged = {**DEFAULT_POLICY, **policy}
        errors: list[str] = []
        for bool_field in (
            "code_change_enabled",
            "auto_pr_enabled",
            "auto_revert_enabled",
        ):
            if bool_field in merged and not isinstance(merged[bool_field], bool):
                errors.append(f"{bool_field} must be a bool")
        for pct_field in (
            "max_blast_radius_score",
            "min_rca_confidence",
            "min_test_pass_rate",
            "min_quality_score",
        ):
            if pct_field in merged:
                v = merged[pct_field]
                if not isinstance(v, (int, float)) or v < 0 or v > 1:
                    errors.append(f"{pct_field} must be a number in [0, 1]")
        if errors:
            return {
                "status": "bad_request",
                "feature": self.name,
                "live": True,
                "trace_id": _new_id("live"),
                "timestamp": None,
                "data": None,
                "message": "; ".join(errors),
            }
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "policy": merged,
                "policy_id": _new_id("pol"),
                "policy_json": _json_dumps(merged),
                "message": (
                    "Stub policy update — Gate 4a will persist to "
                    "organizations.features.code_change_policy and "
                    "fire the on_policy_change hook."
                ),
            },
        )
