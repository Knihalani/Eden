"""Tests for the RateLimiter (read-side defaults; counts need an integration env)."""

from __future__ import annotations

import pytest

from eden.code_change.discipline.rate_limiter import (
    Action,
    DEFAULT_RATE_POLICY,
    RateLimiter,
)


class TestRateLimiterDefaults:
    """The default caps are present + numeric."""

    def test_default_policy_caps(self):
        assert DEFAULT_RATE_POLICY["max_pr_per_repo_per_day"] == 3
        assert DEFAULT_RATE_POLICY["max_pr_per_repo_per_hour"] == 1
        assert DEFAULT_RATE_POLICY["max_pr_per_org_per_day"] == 5

    def test_default_policy_echoed(self):
        limiter = RateLimiter()
        assert limiter.policy["max_pr_per_repo_per_day"] == 3


class TestCustomPolicy:
    """Custom policy overrides the defaults."""

    def test_custom_caps(self):
        limiter = RateLimiter(
            policy={
                "max_pr_per_repo_per_day": 1,
                "max_pr_per_repo_per_hour": 1,
                "max_pr_per_org_per_day": 2,
            },
        )
        assert limiter.policy["max_pr_per_repo_per_day"] == 1
        assert limiter.policy["max_pr_per_org_per_day"] == 2


class TestActionDataclass:
    """The Action dataclass labels log entries."""

    def test_action_kind(self):
        action = Action(kind="open_pr")
        assert action.kind == "open_pr"


class TestRateLimiterFailsClosedOnDbOutage:
    """A DB outage returns allowed=False (fail-closed)."""

    @pytest.mark.asyncio
    async def test_db_outage_returns_disallowed(self, monkeypatch):
        async def _no_db():
            return None

        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client",
            _no_db,
        )
        limiter = RateLimiter()
        verdict = await limiter.check("org_test", "repo_test")
        assert verdict["allowed"] is False
        # At least one of the three caps is exceeded.
        assert (
            verdict["per_repo_per_day"]["exceeded"]
            or verdict["per_repo_per_hour"]["exceeded"]
            or verdict["per_org_per_day"]["exceeded"]
        )
