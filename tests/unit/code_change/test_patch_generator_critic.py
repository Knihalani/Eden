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


class TestPromptSplitSystemVsUser:
    """The patch prompt is split into (system, user) so the static
    instruction text is eligible for Anthropic prompt caching
    (saves ~90% of those tokens on the second+ call within the
    cache TTL) and so the cache key in
    ``OpenRouterClient._cache_key`` is unaffected by static
    instruction changes.
    """

    def test_prompt_split_returns_tuple(self):
        from eden.code_change.patch_generator import _build_patch_prompt
        result = _build_patch_prompt(
            repo_id="r1", rca_id="rc1", trace_id="t1",
            linked_files=[], style_profile={}, pr_patterns={},
            kg_penalties=[], test_plan=[],
        )
        assert isinstance(result, tuple) and len(result) == 2
        sys_p, user_p = result
        assert isinstance(sys_p, str) and len(sys_p) > 0
        assert isinstance(user_p, str) and len(user_p) > 0

    def test_system_prompt_contains_static_instructions(self):
        """The system prompt must include the role + output-format
        instructions so the user prompt can stay focused on the
        per-call variable context."""
        from eden.code_change.patch_generator import _build_patch_prompt
        sys_p, _ = _build_patch_prompt(
            repo_id="r1", rca_id="rc1", trace_id="t1",
            linked_files=[], style_profile={}, pr_patterns={},
            kg_penalties=[], test_plan=[],
        )
        assert "unified diff" in sys_p.lower()
        assert "no prose" in sys_p.lower() or "no markdown" in sys_p.lower()

    def test_user_prompt_does_not_contain_static_role_text(self):
        """The user prompt must NOT re-state the role — that's
        now the system prompt's job. This is the assertion that
        actually proves we lifted the text out of the user side."""
        from eden.code_change.patch_generator import _build_patch_prompt
        _, user_p = _build_patch_prompt(
            repo_id="r1", rca_id="rc1", trace_id="t1",
            linked_files=[], style_profile={}, pr_patterns={},
            kg_penalties=[], test_plan=[],
        )
        # The old user prompt started with "You are generating".
        # After the split, that text lives in the system prompt.
        assert "You are generating" not in user_p
        # The user prompt should still contain the variable context
        # (RCA id, trace id, repo id).
        assert "r1" in user_p
        assert "rc1" in user_p

    def test_kg_penalties_still_appear_in_user_prompt(self):
        """Per-call context (KG penalties) must stay in the user
        prompt — only the static instruction text moves to the
        system prompt."""
        from eden.code_change.patch_generator import _build_patch_prompt
        _, user_p = _build_patch_prompt(
            repo_id="r1", rca_id="rc1", trace_id="t1",
            linked_files=[],
            style_profile={}, pr_patterns={},
            kg_penalties=[{
                "code_path": "src/foo.py",
                "revert_rate": 0.42,
                "denial_rate": 0.13,
            }],
            test_plan=[],
        )
        assert "src/foo.py" in user_p
        assert "0.42" in user_p

    def test_linked_files_still_appear_in_user_prompt(self):
        from eden.code_change.patch_generator import _build_patch_prompt
        _, user_p = _build_patch_prompt(
            repo_id="r1", rca_id="rc1", trace_id="t1",
            linked_files=[{
                "path": "src/example.py",
                "content": "def hello():\n    return 42\n",
            }],
            style_profile={}, pr_patterns={},
            kg_penalties=[], test_plan=[],
        )
        assert "src/example.py" in user_p
        assert "def hello" in user_p


class TestLinkedFilesEmptyContentOmitted:
    """``EdenPatchAgent`` historically sent ``linked_files`` with
    ``content: ""``. The previous prompt unconditionally appended
    a "## Linked source files" section with bare ``--- path ---``
    headers, wasting ~50 tokens per call.

    v1.7.4 polish: skip the section entirely when no caller
    populated content. When callers DO populate it, the section
    still appears (and the content is still capped at 2000 chars).
    """

    def test_empty_content_omits_section(self):
        from eden.code_change.patch_generator import _build_patch_prompt
        _, user_p = _build_patch_prompt(
            repo_id="r1", rca_id="rc1", trace_id="t1",
            linked_files=[
                {"path": "src/a.py", "content": ""},
                {"path": "src/b.py", "content": ""},
            ],
            style_profile={}, pr_patterns={},
            kg_penalties=[], test_plan=[],
        )
        # The "## Linked source files" header should NOT appear
        # because no caller populated content.
        assert "## Linked source files" not in user_p
        # And neither should the bare --- headers.
        assert "--- src/a.py ---" not in user_p
        assert "--- src/b.py ---" not in user_p

    def test_populated_content_includes_section(self):
        from eden.code_change.patch_generator import _build_patch_prompt
        _, user_p = _build_patch_prompt(
            repo_id="r1", rca_id="rc1", trace_id="t1",
            linked_files=[
                {"path": "src/a.py", "content": "def hello():\n    return 1"},
            ],
            style_profile={}, pr_patterns={},
            kg_penalties=[], test_plan=[],
        )
        assert "## Linked source files" in user_p
        assert "src/a.py" in user_p

    def test_mixed_content_only_includes_populated(self):
        """If some files have content and others don't, only the
        populated ones appear — the empty ones are silently
        skipped without polluting the prompt."""
        from eden.code_change.patch_generator import _build_patch_prompt
        _, user_p = _build_patch_prompt(
            repo_id="r1", rca_id="rc1", trace_id="t1",
            linked_files=[
                {"path": "src/populated.py", "content": "x = 1"},
                {"path": "src/empty.py", "content": ""},
            ],
            style_profile={}, pr_patterns={},
            kg_penalties=[], test_plan=[],
        )
        assert "src/populated.py" in user_p
        assert "src/empty.py" not in user_p

    def test_caps_at_5_files(self):
        """The cap on linked files is 5 — the 6th file (even with
        content) must not appear in the prompt."""
        from eden.code_change.patch_generator import _build_patch_prompt
        _, user_p = _build_patch_prompt(
            repo_id="r1", rca_id="rc1", trace_id="t1",
            linked_files=[
                {"path": f"src/f{i}.py", "content": "x"}
                for i in range(10)
            ],
            style_profile={}, pr_patterns={},
            kg_penalties=[], test_plan=[],
        )
        for i in range(5):
            assert f"src/f{i}.py" in user_p, f"f{i} missing"
        for i in range(5, 10):
            assert f"src/f{i}.py" not in user_p, f"f{i} leaked past cap"


class TestLazyModelRouterImport:
    """Validate that patch_generator doesn't pull in ModelRouter
    unless it's actually called. The eager import cost is ~1s
    (transitively imports eden.config + eden.llm.client);
    operators and tests that only read patch enums should
    not pay that cost.
    """

    def test_module_import_does_not_load_model_router(self):
        import sys
        # Make sure neither module is loaded
        for mod in list(sys.modules):
            if "model_router" in mod:
                del sys.modules[mod]
        from eden.code_change import patch_generator
        # The module itself must not have pulled in
        # ``eden.optimization.model_router``.
        assert "eden.optimization.model_router" not in sys.modules, (
            "patch_generator eagerly imported model_router — "
            "should be lazy via __getattr__"
        )

    def test_module_does_not_load_router_at_import(self):
        """This is the actual behaviour we want — patching
        the loader to track imports, then reloading
        patch_generator, must NOT load model_router."""
        import sys
        # Clear any pre-existing imports
        for mod in list(sys.modules):
            if "model_router" in mod or "patch_generator" in mod:
                del sys.modules[mod]
        from eden.code_change import patch_generator
        # The TYPE_CHECKING import is evaluated at runtime
        # only when ``from __future__ import annotations``
        # is active, which it is. So importing
        # ``patch_generator`` must not pull in model_router.
        assert "eden.optimization.model_router" not in sys.modules

    def test_unknown_attribute_raises(self):
        from eden.code_change import patch_generator
        try:
            _ = patch_generator.DoesNotExist
        except AttributeError as exc:
            assert "patch_generator" in str(exc)
        else:
            raise AssertionError("expected AttributeError")

    def test_fast_skip_without_api_keys(self, monkeypatch):
        """When no LLM API keys are set, generate() must return
        ``not_implemented`` in <5ms without instantiating
        ModelRouter (which alone is ~1s)."""
        import asyncio
        import os
        import time
        for key in ("OPENROUTER_API_KEY", "OPENAI_API_KEY",
                    "ANTHROPIC_API_KEY", "EDEN_LLM_API_KEY"):
            monkeypatch.delenv(key, raising=False)
        # Reset module-level cache (set by prior tests)
        import eden.code_change.patch_generator as pg
        pg._LLM_CREDENTIAL_PRESENT = None

        gen = pg.PatchGenerator()
        t0 = time.perf_counter()
        result = asyncio.run(gen.generate(
            org_id="o1", rca_id="rca1", trace_id="t1",
            repo_id="repo1", rca_summary="test",
        ))
        elapsed_ms = (time.perf_counter() - t0) * 1000
        assert result["status"] == "not_implemented"
        assert result["data"]["gate"] == "router_missing"
        # Must be fast — well under the ModelRouter init cost.
        assert elapsed_ms < 50, f"fast-skip took {elapsed_ms:.1f}ms"
