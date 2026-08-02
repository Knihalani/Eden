"""Soft Autonomy Phase 7: soft_issue_review job unit tests.

Pins the budget gate, the L3 novelty-scout parsing, the L4 shadow
detector dedupe, and the per-night multi-pod claim. No network, no DB,
no Redis — all faked.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.services import soft_issue_review
from eden.services.soft_issue_review import (
    _MAX_NEW_DETECTORS_PER_ORG,
    SoftIssueReviewer,
)


def _settings(**over):
    base = {
        "soft_issue_review_enabled": True,
        "soft_issue_review_traces_per_org": 50,
    }
    base.update(over)
    return SimpleNamespace(**base)


def _traces(n: int) -> list[dict]:
    return [
        {
            "trace_id": f"t-{i}",
            "span_name": "checkout",
            "outcome": "failure",
            "stumble_kind": "loop",
            "error": "timeout",
            "cost_usd": "0.01",
        }
        for i in range(n)
    ]


class TestRunOnce:
    @pytest.mark.asyncio
    async def test_disabled_short_circuits(self) -> None:
        with patch.object(
            soft_issue_review, "get_settings",
            return_value=_settings(soft_issue_review_enabled=False),
        ):
            out = await SoftIssueReviewer().run_once()
        assert out == {"skipped": True, "reason": "disabled"}

    @pytest.mark.asyncio
    async def test_no_postgres_skips(self) -> None:
        with (
            patch.object(soft_issue_review, "get_settings", return_value=_settings()),
            patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=None),
            ),
        ):
            out = await SoftIssueReviewer().run_once()
        assert out["reason"] == "postgres_unavailable"

    @pytest.mark.asyncio
    async def test_dry_run_never_claims_or_reviews(self) -> None:
        reviewer = SoftIssueReviewer()
        pg = MagicMock()
        with (
            patch.object(soft_issue_review, "get_settings", return_value=_settings()),
            patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=pg),
            ),
            patch.object(
                reviewer, "_rank_hot_orgs", AsyncMock(return_value=["org-1", "org-2"])
            ),
            patch.object(reviewer, "_claim_org", AsyncMock()) as claim,
            patch.object(reviewer, "_review_org", AsyncMock()) as review,
        ):
            out = await reviewer.run_once(dry_run=True)
        assert out["orgs_ranked"] == 2
        claim.assert_not_called()
        review.assert_not_called()

    @pytest.mark.asyncio
    async def test_unclaimed_org_is_skipped(self) -> None:
        """A second pod that loses the per-org claim must not review."""
        reviewer = SoftIssueReviewer()
        pg = MagicMock()
        with (
            patch.object(soft_issue_review, "get_settings", return_value=_settings()),
            patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=pg),
            ),
            patch.object(reviewer, "_rank_hot_orgs", AsyncMock(return_value=["org-1"])),
            patch.object(reviewer, "_claim_org", AsyncMock(return_value=False)),
            patch.object(reviewer, "_review_org", AsyncMock()) as review,
        ):
            out = await reviewer.run_once()
        assert out["orgs_reviewed"] == 0
        review.assert_not_called()

    @pytest.mark.asyncio
    async def test_one_org_failure_does_not_abort_the_night(self) -> None:
        reviewer = SoftIssueReviewer()
        pg = MagicMock()

        async def _review(_pg, org_id):
            if org_id == "org-bad":
                raise RuntimeError("boom")
            return {"org_id": org_id, "detectors_created": 1, "spend_usd": 0.001}

        with (
            patch.object(soft_issue_review, "get_settings", return_value=_settings()),
            patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=pg),
            ),
            patch.object(
                reviewer, "_rank_hot_orgs", AsyncMock(return_value=["org-bad", "org-ok"])
            ),
            patch.object(reviewer, "_claim_org", AsyncMock(return_value=True)),
            patch.object(reviewer, "_review_org", side_effect=_review),
        ):
            out = await reviewer.run_once()
        assert out["orgs_reviewed"] == 1
        assert out["detectors_created"] == 1
        assert any("errors" in o for o in out["orgs"])


class TestBudgetGate:
    @pytest.mark.asyncio
    async def test_budget_exhausted_skips_before_llm(self) -> None:
        reviewer = SoftIssueReviewer()
        pg = MagicMock()
        with (
            patch(
                "eden.closed_loop.autonomy_policy.check_budget",
                AsyncMock(return_value=(False, 25.0, 25.0)),
            ),
            patch.object(
                reviewer, "_scout_novel_patterns", AsyncMock()
            ) as scout,
        ):
            out = await reviewer._review_org(pg, "org-1")
        assert out["reason"] == "budget_exhausted"
        scout.assert_not_called()


class TestNoveltyScoutParsing:
    def test_clean_json(self) -> None:
        content = json.dumps(
            {"patterns": ["agent re-asks for info it already received"]}
        )
        out = SoftIssueReviewer._parse_patterns(content)
        assert out == ["agent re-asks for info it already received"]

    def test_prose_wrapped_json(self) -> None:
        content = 'Sure! {"patterns": ["loops on the same failing tool call"]} hope this helps'
        out = SoftIssueReviewer._parse_patterns(content)
        assert out == ["loops on the same failing tool call"]

    def test_empty_and_garbage(self) -> None:
        assert SoftIssueReviewer._parse_patterns("") == []
        assert SoftIssueReviewer._parse_patterns("not json at all") == []
        assert SoftIssueReviewer._parse_patterns('{"patterns": "nope"}') == []

    def test_caps_and_filters(self) -> None:
        content = json.dumps(
            {
                "patterns": [
                    "short",  # too short — filtered
                    "x" * 400,  # too long — filtered
                    "agent repeats the same apology without fixing anything",
                    "agent silently drops tool outputs from its answers",
                    "agent asks the user to re-authenticate on every turn",
                    "a fourth pattern that must be capped away entirely",
                ]
            }
        )
        out = SoftIssueReviewer._parse_patterns(content)
        assert len(out) == _MAX_NEW_DETECTORS_PER_ORG
        assert all(20 <= len(p) <= 300 for p in out)


class TestShadowDetector:
    @pytest.mark.asyncio
    async def test_insert_disabled_with_auto_cluster(self) -> None:
        reviewer = SoftIssueReviewer()
        captured: dict = {}

        class _PG:
            async def fetchval(self, sql, *args):
                return None  # no dupe

            async def execute(self, sql, *args):
                captured["args"] = args

        with patch.object(
            reviewer, "_claim_org", AsyncMock(return_value=True)
        ):
            made = await reviewer._create_shadow_detector(
                _PG(), "org-1", "agent-1", "agent re-asks for info it already received"
            )
        assert made is True
        args = captured["args"]
        assert args[1] == "org-1"
        assert args[2].startswith("[auto:agent-1]")
        assert args[4].startswith("auto:")  # content-addressed cluster id

    @pytest.mark.asyncio
    async def test_dupe_cluster_id_is_idempotent(self) -> None:
        reviewer = SoftIssueReviewer()

        class _PG:
            async def fetchval(self, sql, *args):
                return 1  # already exists

            async def execute(self, sql, *args):
                raise AssertionError("must not insert a duplicate")

        made = await reviewer._create_shadow_detector(
            _PG(), "org-1", "agent-1", "agent re-asks for info it already received"
        )
        assert made is False


class TestClaim:
    @pytest.mark.asyncio
    async def test_claim_uses_set_nx_with_nightly_ttl(self) -> None:
        reviewer = SoftIssueReviewer()
        redis = MagicMock()
        redis.set = AsyncMock(return_value=True)
        with patch(
            "eden.storage.redis.get_redis_client", AsyncMock(return_value=redis)
        ):
            assert await reviewer._claim_org("org-1") is True
        kwargs = redis.set.call_args.kwargs
        assert kwargs["nx"] is True
        assert kwargs["ex"] == 20 * 3600
        assert "org-1" in redis.set.call_args.args[0]

    @pytest.mark.asyncio
    async def test_claim_fails_open_when_redis_down(self) -> None:
        reviewer = SoftIssueReviewer()
        with patch(
            "eden.storage.redis.get_redis_client", AsyncMock(return_value=None)
        ):
            assert await reviewer._claim_org("org-1") is True
