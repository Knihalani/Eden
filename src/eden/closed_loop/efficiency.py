"""AgentEfficiencyController — anti-spam / coalesce for the closed loop.

Primary controls (not a mandatory dollar budget):

* Don't re-run diagnosis for an issue that already has triage.
* Suppress patch generation while an open patch exists for the same RCA.
* Only fire the scheduled agent when :func:`schedule_due.is_optimization_due`.
* Optional org budget (``daily_maintenance_budget_usd``) — ``null``/unset
  means unlimited.

Entry points:

* :meth:`should_run_triage` — F46 ``_on_issue_created``
* :meth:`should_run_patch` — N20 ``propose_patch_for_issue`` / F46 patch path
* :meth:`should_run_scheduled` — ``cron_tick`` scheduled optimization
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

_OPEN_PATCH_STATUSES = ("proposed", "pending_review", "approved")


class AgentEfficiencyController:
    """Coalesce / suppress autonomous agent work."""

    name = "agent_efficiency"

    async def should_run_triage(
        self,
        org_id: str,
        issue_id: str,
        *,
        issue: Any | None = None,
        force: bool = False,
        policy: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        """Return ``(allowed, reason)`` for a triage run."""
        if force:
            return True, "forced"

        if issue is None:
            try:
                from eden.issues.repo import IssuesRepo

                issue = await IssuesRepo().get_issue(org_id, issue_id)
            except Exception as exc:
                logger.debug("efficiency.triage: load issue failed: %s", exc)
                issue = None

        triage_result = None
        if issue is not None:
            triage_result = getattr(issue, "triage_result", None)
            if triage_result is None and isinstance(issue, dict):
                triage_result = issue.get("triage_result")

        if triage_result:
            return False, "already_triaged"

        budget_block = await self._optional_budget_exhausted(org_id, policy)
        if budget_block:
            return False, budget_block

        # Suppress triage spam while a patch is already open for this issue.
        rca_id = f"iss_{issue_id}"
        open_patch = await self._open_patch_for_rca(org_id, rca_id)
        if open_patch is not None:
            return False, "active_patch_in_flight"

        return True, "ok"

    async def should_run_patch(
        self,
        org_id: str,
        issue_id: str,
        *,
        rca_id: str | None = None,
        policy: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        """Return ``(allowed, reason)`` for an issue-scoped patch propose."""
        rca = rca_id or f"iss_{issue_id}"
        open_patch = await self._open_patch_for_rca(org_id, rca)
        if open_patch is not None:
            return False, "duplicate_open_patch"

        budget_block = await self._optional_budget_exhausted(org_id, policy)
        if budget_block:
            return False, budget_block

        return True, "ok"

    async def should_run_scheduled(
        self,
        org_id: str,
        policy: dict[str, Any] | None,
        *,
        now: datetime | None = None,
    ) -> tuple[bool, str]:
        """Return ``(allowed, reason)`` for the recurring optimization agent."""
        policy = policy or {}
        if not policy.get("code_change_enabled"):
            return False, "code_change_enabled=false"

        from eden.code_change.schedule_due import is_optimization_due

        if not is_optimization_due(policy, now=now or datetime.now(UTC)):
            return False, "not_due"

        budget_block = await self._optional_budget_exhausted(org_id, policy)
        if budget_block:
            return False, budget_block

        return True, "due"

    # ── helpers ─────────────────────────────────────────────────────

    async def _open_patch_for_rca(
        self, org_id: str, rca_id: str
    ) -> dict[str, Any] | None:
        try:
            from eden.code_change._common import _select_rows

            # status IN (...) — literal statuses (no user input).
            statuses = ", ".join(f"'{s}'" for s in _OPEN_PATCH_STATUSES)
            rows = await _select_rows(
                org_id,
                "proposed_patches",
                where=f"rca_id = $2 AND status IN ({statuses})",
                params=(rca_id,),
                limit=1,
            )
            return rows[0] if rows else None
        except Exception as exc:
            logger.debug("efficiency.open_patch lookup failed: %s", exc)
            return None

    async def _optional_budget_exhausted(
        self, org_id: str, policy: dict[str, Any] | None
    ) -> str | None:
        """Return a reason string when an optional org budget is exhausted.

        ``null`` / missing ``daily_maintenance_budget_usd`` → unlimited.
        """
        policy = policy or {}
        raw = policy.get("daily_maintenance_budget_usd", None)
        if raw is None:
            return None
        try:
            cap = float(raw)
        except (TypeError, ValueError):
            return None
        if cap <= 0:
            return None
        spend = await self._today_spend_usd(org_id)
        if spend >= cap:
            return f"budget_exhausted:{spend:.2f}>={cap:.2f}"
        return None

    async def _today_spend_usd(self, org_id: str) -> float:
        """Best-effort read of today's maintenance spend (Redis). Fail-open → 0."""
        try:
            from eden.closed_loop.autonomy_policy import _SPEND_PREFIX, _redis, _today

            redis = await _redis()
            if redis is None:
                return 0.0
            raw = await redis.get(f"{_SPEND_PREFIX}{org_id}:{_today()}")
            return float(raw) if raw else 0.0
        except Exception:
            return 0.0
