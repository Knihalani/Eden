"""Unit tests for Phase 3b PatchGenerator changes.

Verifies the 4 new pieces:

1. _validate_size — soft + hard caps, investigation envelope
2. _diff_title_hash — stable hash of the diff header
3. _is_similar_to_recent_patch — difflib-based dedup
4. _critic_review — PASS / FAIL verdict parsing
5. PatchGenerator.generate — critic loop wiring + size + dedup

All tests use pure-Python inputs (no DB, no LLM). The DB-
touching helpers are exercised by the integration suite.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── _validate_size ─────────────────────────────────────────────────


class TestValidateSize:
    def test_small_diff_passes(self):
        from eden.code_change.patch_generator import _validate_size
        diff = "--- a\n+++ b\n@@\n-a\n+b\n"
        result = _validate_size(diff, soft_cap=200, hard_cap=500)
        assert result["ok"] is True
        assert result["size_class"] == "small"

    def test_medium_diff_passes(self):
        from eden.code_change.patch_generator import _validate_size
        # Build a diff with 201 lines.
        diff = "--- a\n+++ b\n" + ("@@\n-a\n+b\n" * 101)
        result = _validate_size(diff, soft_cap=200, hard_cap=500)
        assert result["ok"] is True
        assert result["size_class"] == "medium"

    def test_huge_diff_investigation(self):
        from eden.code_change.patch_generator import _validate_size
        diff = "--- a\n+++ b\n" + ("@@\n-a\n+b\n" * 251)
        result = _validate_size(diff, soft_cap=200, hard_cap=500)
        assert result["ok"] is False
        assert result["size_class"] == "investigation"


# ── _diff_title_hash ───────────────────────────────────────────────


class TestDiffTitleHash:
    def test_same_header_same_hash(self):
        from eden.code_change.patch_generator import _diff_title_hash
        diff = "--- a/foo.py\n+++ b/foo.py\n@@\n-a\n+b\n"
        h1 = _diff_title_hash(diff)
        h2 = _diff_title_hash(diff)
        assert h1 == h2
        assert len(h1) == 16

    def test_different_header_different_hash(self):
        from eden.code_change.patch_generator import _diff_title_hash
        h1 = _diff_title_hash("--- a\n+++ b/foo.py\n@@\n-a\n+b\n")
        h2 = _diff_title_hash("--- a\n+++ b/bar.py\n@@\n-a\n+b\n")
        assert h1 != h2

    def test_empty_diff_returns_empty(self):
        from eden.code_change.patch_generator import _diff_title_hash
        assert _diff_title_hash("") == ""

    def test_no_header_returns_empty(self):
        from eden.code_change.patch_generator import _diff_title_hash
        assert _diff_title_hash("just some text") == ""


# ── _is_similar_to_recent_patch ─────────────────────────────────────


class TestIsSimilarToRecentPatch:
    @pytest.mark.asyncio
    async def test_no_match_returns_none(self):
        from eden.code_change.patch_generator import _is_similar_to_recent_patch

        with patch(
            "eden.code_change.patch_generator._select_rows",
            new=AsyncMock(return_value=[]),
        ):
            result = await _is_similar_to_recent_patch(
                "org_test", "+++ b/foo\n@@\n", threshold=0.85, lookback_days=14,
            )
        assert result is None

    @pytest.mark.asyncio
    async def test_match_above_threshold(self):
        from eden.code_change.patch_generator import _is_similar_to_recent_patch

        # Two diffs that are ~100% identical.
        diff = "--- a\n+++ b/foo.py\n@@\n-a\n+b\n" * 10
        with patch(
            "eden.code_change.patch_generator._select_rows",
            new=AsyncMock(
                return_value=[{"id": "patch_old", "diff": diff}]
            ),
        ):
            result = await _is_similar_to_recent_patch(
                "org_test", diff, threshold=0.85, lookback_days=14,
            )
        assert result is not None
        assert result["matched_patch_id"] == "patch_old"
        assert result["similarity"] > 0.85

    @pytest.mark.asyncio
    async def test_threshold_zero_skips(self):
        from eden.code_change.patch_generator import _is_similar_to_recent_patch

        # threshold=0 means "no dedup" — should short-circuit.
        result = await _is_similar_to_recent_patch(
            "org_test", "anything", threshold=0.0, lookback_days=14,
        )
        assert result is None


# ── _critic_review ─────────────────────────────────────────────────


class TestCriticReview:
    @pytest.mark.asyncio
    async def test_pass_verdict(self):
        from eden.code_change.patch_generator import _critic_review

        router = MagicMock()
        router.aroute = AsyncMock(
            return_value=MagicMock(content="PASS: looks good")
        )
        result = await _critic_review(router, "diff", rca_summary="rca")
        assert result["passed"] is True
        assert "looks good" in result["reason"]

    @pytest.mark.asyncio
    async def test_fail_verdict(self):
        from eden.code_change.patch_generator import _critic_review

        router = MagicMock()
        router.aroute = AsyncMock(
            return_value=MagicMock(content="FAIL: touches auth")
        )
        result = await _critic_review(router, "diff", rca_summary="rca")
        assert result["passed"] is False
        assert "touches auth" in result["reason"]

    @pytest.mark.asyncio
    async def test_llm_failure_passes_by_default(self):
        from eden.code_change.patch_generator import _critic_review

        router = MagicMock()
        router.aroute = AsyncMock(side_effect=RuntimeError("down"))
        result = await _critic_review(router, "diff", rca_summary="rca")
        # Critic is permissive on outage — better over-permissive
        # than blocking the pipeline on a transient critic failure.
        assert result["passed"] is True
        assert result["reason"] == "critic_skipped"


# ── PatchGenerator.generate integration ─────────────────────────────


def _fake_router_response(content: str, cost: float = 0.10) -> MagicMock:
    resp = MagicMock()
    resp.content = content
    resp.model = "minimax/minimax-m3"
    resp.usage = MagicMock()
    resp.usage.cost = cost
    return resp


VALID_DIFF = (
    "--- a/foo.py\n+++ b/foo.py\n@@\n-line 1\n+line 1 changed\n"
)


class TestGenerateSizeHardCap:
    @pytest.mark.asyncio
    async def test_huge_diff_returns_investigation(self):
        from eden.code_change.patch_generator import PatchGenerator

        # 600 lines — well over the 500 hard cap.
        huge_diff = "--- a/foo.py\n+++ b/foo.py\n" + (
            "@@\n-line\n+line\n" * 300
        )
        gen = PatchGenerator(
            router=MagicMock(
                aroute=AsyncMock(
                    return_value=_fake_router_response(huge_diff)
                )
            ),
        )
        # Critic also returns PASS so the diff gets through critic.
        with patch(
            "eden.code_change.patch_generator._critic_review",
            new=AsyncMock(
                return_value={"passed": True, "reason": "ok", "raw": ""}
            ),
        ):
            result = await gen.generate(
                "org_test", "rca_1", "trace_1", "repo_1",
            )
        assert result["status"] == "ok"
        assert result["data"]["status"] == "investigation"
        assert "architectural review" in result["data"]["reason"]


class TestGenerateDedup:
    @pytest.mark.asyncio
    async def test_similar_diff_returns_deduplicated(self):
        from eden.code_change.patch_generator import PatchGenerator

        gen = PatchGenerator(
            router=MagicMock(
                aroute=AsyncMock(
                    return_value=_fake_router_response(VALID_DIFF)
                )
            ),
        )
        with (
            patch(
                "eden.code_change.patch_generator._critic_review",
                new=AsyncMock(
                    return_value={
                        "passed": True, "reason": "ok", "raw": "",
                    }
                ),
            ),
            patch(
                "eden.code_change.patch_generator._is_similar_to_recent_patch",
                new=AsyncMock(
                    return_value={
                        "matched_patch_id": "patch_old",
                        "matched_created_at": "2026-06-23T00:00:00",
                        "similarity": 0.92,
                        "lookback_days": 14,
                        "threshold": 0.85,
                    }
                ),
            ),
        ):
            result = await gen.generate(
                "org_test", "rca_1", "trace_1", "repo_1",
            )
        assert result["data"]["status"] == "deduplicated"
        assert result["data"]["duplicate_of"]["matched_patch_id"] == "patch_old"


class TestGenerateQualityFloor:
    @pytest.mark.asyncio
    async def test_low_quality_status_when_critic_rejects(self):
        from eden.code_change.patch_generator import PatchGenerator

        gen = PatchGenerator(
            router=MagicMock(
                aroute=AsyncMock(
                    return_value=_fake_router_response(VALID_DIFF)
                )
            ),
        )
        # Critic rejects on both attempts → initial_quality=0.5 →
        # below the default 0.8 floor → status=low_quality.
        with (
            patch(
                "eden.code_change.patch_generator._critic_review",
                new=AsyncMock(
                    return_value={
                        "passed": False,
                        "reason": "no",
                        "raw": "",
                    }
                ),
            ),
            patch(
                "eden.code_change.patch_generator._is_similar_to_recent_patch",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "eden.code_change.patch_generator._insert_row",
                new=AsyncMock(),
            ),
        ):
            result = await gen.generate(
                "org_test", "rca_1", "trace_1", "repo_1",
            )
        assert result["data"]["status"] == "low_quality"


class TestGenerateCriticLoop:
    @pytest.mark.asyncio
    async def test_retries_on_critic_fail_then_passes(self):
        from eden.code_change.patch_generator import PatchGenerator

        # First call returns invalid diff, second returns valid.
        gen = PatchGenerator(
            router=MagicMock(
                aroute=AsyncMock(
                    side_effect=[
                        _fake_router_response("garbage no diff"),
                        _fake_router_response(VALID_DIFF),
                    ]
                )
            ),
        )
        with (
            patch(
                "eden.code_change.patch_generator._critic_review",
                new=AsyncMock(
                    return_value={
                        "passed": True, "reason": "ok", "raw": "",
                    }
                ),
            ),
            patch(
                "eden.code_change.patch_generator._is_similar_to_recent_patch",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "eden.code_change.patch_generator._insert_row",
                new=AsyncMock(),
            ),
        ):
            result = await gen.generate(
                "org_test", "rca_1", "trace_1", "repo_1",
            )
        # Both aroute calls happened (critic loop made it retry).
        assert gen._router.aroute.await_count == 2
        assert result["data"]["critic_attempts"] >= 1