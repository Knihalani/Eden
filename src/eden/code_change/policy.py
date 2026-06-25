"""CodeChangePolicyService — per-tenant + per-repo opt-in policy.

Real implementation (June 2026 audit pass):

* ``get`` reads ``organizations.features->>'code_change_policy'``
  and merges it over :data:`DEFAULT_POLICY`. The merged
  policy is cached per-request by the caller.
* ``update`` validates the input, merges over the current
  stored policy (so partial updates don't drop fields), then
  writes back to the same JSONB column.

The v1.6 Cat 23 two-stage opt-in stays:

1. ``code_change_enabled`` — master switch (default false).
2. ``auto_pr_enabled`` / ``auto_revert_enabled`` — auto-mode
   opt-ins (both default false).

Validation is enforced on every update — bad values return
``status: bad_request`` without writing.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from eden.storage.postgres import get_postgres_client

from ._common import DEFAULT_POLICY, _new_id, _ok_envelope

logger = logging.getLogger(__name__)


_VALID_PCT_FIELDS = (
    "max_blast_radius_score",
    "min_rca_confidence",
    "min_test_pass_rate",
    "min_quality_score",
)


async def _read_policy_jsonb(org_id: str) -> dict[str, Any]:
    """Read ``organizations.features->'code_change_policy'`` for this org."""
    try:
        client = await get_postgres_client()
        if client is None:
            return {}
        async with client.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT features->'code_change_policy' AS policy "
                "FROM organizations WHERE id = $1",
                org_id,
            )
        if row is None:
            return {}
        raw = row.get("policy")
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except Exception:
                return {}
        if isinstance(raw, dict):
            return raw
        return {}
    except Exception as exc:
        logger.debug("policy.get: read failed: %s", exc)
        return {}


async def _write_policy_jsonb(
    org_id: str, merged_policy: dict[str, Any],
) -> bool:
    """Write the merged policy back to organizations.features.code_change_policy.

    Uses JSONB merge-update so other feature flags in the same
    column (e.g. ``autonomous_actions_v0``) are preserved.
    """
    try:
        client = await get_postgres_client()
        if client is None:
            return False
        async with client.acquire() as conn:
            result = await conn.execute(
                "UPDATE organizations SET features = "
                "COALESCE(features, '{}'::jsonb) || $1::jsonb "
                "WHERE id = $2",
                json.dumps({"code_change_policy": merged_policy}),
                org_id,
            )
        return result.endswith(" 1")
    except Exception as exc:
        logger.debug("policy.update: write failed: %s", exc)
        return False


def _validate_policy(policy: dict[str, Any]) -> list[str]:
    """Return a list of validation errors (empty list = OK)."""
    errors: list[str] = []
    for bool_field in (
        "code_change_enabled",
        "auto_pr_enabled",
        "auto_revert_enabled",
    ):
        if bool_field in policy and not isinstance(policy[bool_field], bool):
            errors.append(f"{bool_field} must be a bool")
    for pct_field in _VALID_PCT_FIELDS:
        if pct_field in policy:
            v = policy[pct_field]
            if not isinstance(v, (int, float)) or v < 0 or v > 1:
                errors.append(f"{pct_field} must be a number in [0, 1]")
    return errors


class CodeChangePolicyService:
    """Per-tenant + per-repo Cat 23 opt-in policy."""

    name = "code_change_policy"

    async def get(self, org_id: str) -> dict[str, Any]:
        """Read the persisted policy, merged over defaults."""
        stored = await _read_policy_jsonb(org_id)
        merged = {**DEFAULT_POLICY, **stored}
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "policy": merged,
                "policy_source": "stored" if stored else "defaults",
            },
        )

    async def update(
        self,
        org_id: str,
        policy: dict[str, Any],
    ) -> dict[str, Any]:
        """Validate, merge over current stored policy, persist."""
        existing = await _read_policy_jsonb(org_id)
        # Merge: input overrides existing, existing fills gaps,
        # defaults fill the rest.
        merged = {**DEFAULT_POLICY, **existing, **policy}
        errors = _validate_policy(merged)
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
        ok = await _write_policy_jsonb(org_id, merged)
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "policy": merged,
                "policy_id": _new_id("pol"),
                "persisted": ok,
                "message": (
                    "policy updated"
                    if ok
                    else "policy validated but persistence failed"
                ),
            },
        )
