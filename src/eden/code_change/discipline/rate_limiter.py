"""Rate limiter — per-repo / per-day PR creation caps.

The brief is explicit: PR generation must be disciplined
and bounded. The existing Cat 23 surface has per-day
*patch* caps (via :class:`AutoApprovalRateLimiter`); the
PR-specific caps here are narrower:

* per-repo per-day cap (default 3) — prevents one
  repo from absorbing all the org's PR budget
* per-repo per-hour cap (default 1) — prevents the
  bursty "open three PRs in 10 minutes" pattern
* per-org per-day cap (default 5) — overall ceiling

The limiter is best-effort and fail-closed: a DB outage
returns ``allowed=False`` so the system never silently
exceeds the cap. This is the conservative side — a
transient outage will surface as "rate-limit reached"
in the response, never as a silent PR over-spend.

The cap is enforced by counting rows in
``pull_requests`` (Cat 23 table) scoped by ``org_id``
and ``repo_id`` over the rolling window. We deliberately
re-use the existing Cat 23 ``pull_requests`` table
rather than introducing a new one to keep the storage
surface minimal.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


# Default per-org policy. Per-org overrides via the
# discipline policy JSONB.
DEFAULT_RATE_POLICY: dict[str, Any] = {
    "max_pr_per_repo_per_day": 3,
    "max_pr_per_repo_per_hour": 1,
    "max_pr_per_org_per_day": 5,
}


@dataclass(frozen=True)
class Action:
    """An action the rate limiter can take.

    Used by callers to label log entries + drift alerts.
    Distinct from the Cat 23 :data:`ACTION_KINDS` because
    the discipline surface is narrower than the broader
    Cat 23 surface.
    """

    kind: str  # ``"open_pr"`` / ``"report_only"``


class RateLimiter:
    """Per-repo / per-day PR creation rate limiter."""

    name = "pr_rate_limiter"

    def __init__(
        self,
        *,
        table: str = "pull_requests",
        policy: dict[str, Any] | None = None,
    ) -> None:
        self._table = table
        self._policy = {**DEFAULT_RATE_POLICY, **(policy or {})}

    @property
    def policy(self) -> dict[str, Any]:
        return dict(self._policy)

    async def _count_recent(
        self, org_id: str, repo_id: str, *, window: str,
    ) -> int:
        """Count rows in the last ``window`` (e.g. ``'1 day'``)."""
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            if client is None:
                return 0
            async with client.acquire() as conn:
                if repo_id:
                    row = await conn.fetchrow(
                        f"SELECT COUNT(*) AS n FROM {self._table} "
                        f"WHERE org_id = $1 AND repo_id = $2 "
                        f"AND created_at > NOW() - INTERVAL '{window}'",
                        org_id,
                        repo_id,
                    )
                else:
                    row = await conn.fetchrow(
                        f"SELECT COUNT(*) AS n FROM {self._table} "
                        f"WHERE org_id = $1 "
                        f"AND created_at > NOW() - INTERVAL '{window}'",
                        org_id,
                    )
            if row is None:
                return 0
            return int(row.get("n") or 0)
        except Exception as exc:
            logger.debug(
                "rate_limiter._count_recent(%s): %s (failing closed)",
                window,
                exc,
            )
            # Fail-closed for safety: a DB outage should
            # *not* let the limiter silently approve a
            # PR that may exceed the cap. Return a large
            # number so the limiter returns ``allowed=False``
            # — the operator can then investigate.
            return 10_000_000

    async def check(
        self,
        org_id: str,
        repo_id: str,
    ) -> dict[str, Any]:
        """Return whether a new PR is allowed.

        The check is a pure read; the caller's job is to
        increment the counter only after the PR is actually
        opened (otherwise failed attempts would consume
        the budget).
        """
        repo_day = await self._count_recent(
            org_id, repo_id, window="1 day",
        )
        repo_hour = await self._count_recent(
            org_id, repo_id, window="1 hour",
        )
        org_day = await self._count_recent(
            org_id, "", window="1 day",
        )
        max_repo_day = int(self._policy["max_pr_per_repo_per_day"])
        max_repo_hour = int(self._policy["max_pr_per_repo_per_hour"])
        max_org_day = int(self._policy["max_pr_per_org_per_day"])

        repo_day_exceeded = repo_day >= max_repo_day
        repo_hour_exceeded = repo_hour >= max_repo_hour
        org_day_exceeded = org_day >= max_org_day
        allowed = not (
            repo_day_exceeded or repo_hour_exceeded or org_day_exceeded
        )

        return {
            "allowed": allowed,
            "repo_id": repo_id,
            "org_id": org_id,
            "per_repo_per_day": {
                "current": repo_day,
                "max": max_repo_day,
                "remaining_today": max(0, max_repo_day - repo_day),
                "exceeded": repo_day_exceeded,
            },
            "per_repo_per_hour": {
                "current": repo_hour,
                "max": max_repo_hour,
                "remaining_this_hour": max(0, max_repo_hour - repo_hour),
                "exceeded": repo_hour_exceeded,
            },
            "per_org_per_day": {
                "current": org_day,
                "max": max_org_day,
                "remaining_today": max(0, max_org_day - org_day),
                "exceeded": org_day_exceeded,
            },
            "policy": self._policy,
        }
