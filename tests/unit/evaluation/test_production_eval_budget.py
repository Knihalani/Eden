"""A stumble may skip the sample rate. It must not skip the spend cap.

``maybe_score_trace`` read:

    if not is_stumble and not self._should_sample(trace_id, policy):
        return None
    if not is_stumble and not await self._budget_allows(org_id, policy):
        return None

The first line is deliberate -- a failing trace is always worth scoring, which
is what the flag is for. The second carried the exemption over to
``max_cost_usd_per_day``, and that is a spend ceiling, not a sampling knob.

Stumbles are precisely the traces that arrive in bursts. An agent looping on a
broken tool emits thousands of them, each costing a judge call, so the cap
stopped applying exactly when it was needed: daily spend was bounded by the
failure rate instead of by the policy. Nothing errored -- the org was billed
and the budget row simply kept climbing past its own limit.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.evaluation.production.sampler import ProductionEvalSampler


class _Sampler(ProductionEvalSampler):
    """Sampler with every collaborator stubbed except the budget gate."""

    def __init__(
        self,
        *,
        budget_allows: bool,
        policy: dict[str, Any] | None = None,
    ) -> None:
        self._budget_allows_result = budget_allows
        self._policy = policy or {"enabled": True, "sample_rate": 0.0}
        self.budget_checked = False
        self.scored = False

    def _enabled(self) -> bool:
        return True

    async def _resolve_policy(self, org_id: str, agent_id: str | None) -> dict[str, Any]:
        return self._policy

    async def _budget_allows(self, org_id: str, policy: dict[str, Any]) -> bool:
        self.budget_checked = True
        return self._budget_allows_result

    def _should_sample(self, trace_id: str, policy: dict[str, Any]) -> bool:
        # Rate 0.0 -- nothing is sampled unless it is a stumble.
        return False

    async def _score_trace(
        self, org_id: str, trace_id: str, agent_id: str | None
    ) -> tuple[float, bool, float]:
        self.scored = True
        return 0.8, True, 0.001

    async def _org_has_rules(self, org_id: str) -> bool:
        return True

    async def _persist_score(self, *a: Any, **k: Any) -> str | None:
        return "row-1"

    async def _record_spend(self, *a: Any, **k: Any) -> None:
        return None


class TestStumbleRespectsTheBudget:
    @pytest.mark.asyncio
    async def test_stumble_is_refused_when_the_cap_is_reached(self) -> None:
        """The regression: this used to score and bill regardless."""
        s = _Sampler(budget_allows=False)
        got = await s.maybe_score_trace("org-1", "trace-1", is_stumble=True)

        assert got is None, "a stumble was scored after the daily cap was hit"
        assert s.budget_checked, "the budget gate was never consulted"
        assert not s.scored, "the judge call ran despite the cap"

    @pytest.mark.asyncio
    async def test_stumble_is_scored_when_budget_remains(self) -> None:
        s = _Sampler(budget_allows=True)
        got = await s.maybe_score_trace("org-1", "trace-1", is_stumble=True)
        assert got is not None
        assert s.scored

    @pytest.mark.asyncio
    async def test_non_stumble_still_refused_when_the_cap_is_reached(self) -> None:
        s = _Sampler(budget_allows=False)
        # Sample rate is 0.0, so this returns before the budget either way --
        # asserted so the two paths cannot be confused for one another.
        assert await s.maybe_score_trace("org-1", "trace-1") is None
        assert not s.scored


class TestSampleRateExemptionIsPreserved:
    """The intended half of the flag must keep working."""

    @pytest.mark.asyncio
    async def test_stumble_bypasses_the_sample_rate(self) -> None:
        s = _Sampler(budget_allows=True)
        # ``_should_sample`` returns False for everything here.
        assert await s.maybe_score_trace("org-1", "trace-1", is_stumble=True) is not None
        assert await s.maybe_score_trace("org-1", "trace-1") is None, (
            "a non-stumble was scored despite a 0.0 sample rate"
        )

    @pytest.mark.asyncio
    async def test_a_disabled_policy_still_wins_over_a_stumble(self) -> None:
        s = _Sampler(budget_allows=True, policy={"enabled": False})
        assert await s.maybe_score_trace("org-1", "trace-1", is_stumble=True) is None
        assert not s.budget_checked, "policy check must short-circuit first"


class TestBudgetGateFailsClosed:
    """A DB error on the budget read must not open the gate."""

    @pytest.mark.asyncio
    async def test_db_error_refuses_rather_than_allowing_spend(self) -> None:
        sampler = ProductionEvalSampler()

        class _Client:
            async def fetchrow(self, *a: Any, **k: Any) -> dict[str, Any]:
                raise RuntimeError("connection reset")

        async def _client() -> Any:
            return _Client()

        sampler._client = _client  # type: ignore[method-assign]
        allowed = await sampler._budget_allows("org-1", {"max_cost_usd_per_day": 50.0})
        assert allowed is False, "budget check failed open on a DB error"

    @pytest.mark.asyncio
    async def test_spend_at_the_cap_is_refused(self) -> None:
        sampler = ProductionEvalSampler()

        class _Client:
            async def fetchrow(self, *a: Any, **k: Any) -> dict[str, Any]:
                return {"spend_usd": 50.0}

        async def _client() -> Any:
            return _Client()

        sampler._client = _client  # type: ignore[method-assign]
        assert (
            await sampler._budget_allows("org-1", {"max_cost_usd_per_day": 50.0})
            is False
        )

    @pytest.mark.asyncio
    async def test_spend_below_the_cap_is_allowed(self) -> None:
        sampler = ProductionEvalSampler()

        class _Client:
            async def fetchrow(self, *a: Any, **k: Any) -> dict[str, Any]:
                return {"spend_usd": 1.0}

        async def _client() -> Any:
            return _Client()

        sampler._client = _client  # type: ignore[method-assign]
        assert (
            await sampler._budget_allows("org-1", {"max_cost_usd_per_day": 50.0}) is True
        )
