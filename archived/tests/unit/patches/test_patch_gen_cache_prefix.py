"""OOM W4-3 (L5) — static prefix stability across patch-gen critic retries.

The ``_build_patch_prompt`` function returns a (system_prompt, user_prompt)
pair.  The *system_prompt* is ``_PATCH_GEN_SYSTEM_PROMPT`` — a module-level
constant.  The refactored ``PatchGenerator.generate`` loop stores the base
user prompt in ``_static_prompt`` (never mutated) and accumulates feedback
into ``_dynamic_sections``, concatenating them fresh at each ``aroute`` call.

This verifies:

1. The system prompt returned by ``_build_patch_prompt`` is exactly the
   module-level constant (byte-stable by definition).

2. Within one ``generate()`` call, the static prefix fed to attempt-0 is a
   byte-identical prefix of the prompt fed to attempt-1 (the critic-retry
   path).  The prefix of attempt-1 equals attempt-0's full prompt, and the
   suffix contains the critic feedback.

3. ``patch_gen_model_override`` is wired to ``PipelineTask.model_override``
   (default empty → no override; non-empty → override propagates to task).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.patches.patch_generator import _build_patch_prompt, _PATCH_GEN_SYSTEM_PROMPT

# A minimal valid diff that passes _is_valid_diff.
_GOOD_DIFF = (
    "diff --git a/foo.py b/foo.py\n"
    "--- a/foo.py\n"
    "+++ b/foo.py\n"
    "@@ -1 +1 @@\n"
    "-old\n"
    "+new\n"
)


def _make_response(content: str = _GOOD_DIFF) -> SimpleNamespace:
    usage = SimpleNamespace(
        prompt_tokens=100,
        completion_tokens=20,
        total_tokens=120,
        cost=0.001,
        cache_reads=0,
        cache_writes=0,
        cache_discount=None,
    )
    return SimpleNamespace(
        content=content,
        usage=usage,
        model="deepseek/deepseek-v4-flash-0731",
    )


def _fake_settings(patch_gen_model_override: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        patch_max_diff_lines_soft=200,
        patch_max_diff_lines_hard=500,
        patch_similarity_threshold=0.85,
        patch_similarity_lookback_days=14,
        patch_quality_floor=0.8,
        patch_gen_model_override=patch_gen_model_override,
    )


# ─────────────────────────────────────────────────────────────────────────────
# _build_patch_prompt — system prompt identity
# ─────────────────────────────────────────────────────────────────────────────

class TestBuildPatchPromptSystemPrompt:
    def test_system_prompt_is_module_constant(self):
        """The returned system prompt is exactly _PATCH_GEN_SYSTEM_PROMPT."""
        sys_p, _ = _build_patch_prompt(
            repo_id="r1",
            rca_id="rca-1",
            trace_id="t1",
            linked_files=[],
            style_profile={},
            pr_patterns={},
            kg_penalties=[],
            test_plan=[],
        )
        assert sys_p is _PATCH_GEN_SYSTEM_PROMPT

    def test_system_prompt_non_empty(self):
        """The system prompt must be a non-empty string."""
        sys_p, _ = _build_patch_prompt(
            repo_id="r2",
            rca_id="rca-2",
            trace_id="t2",
            linked_files=[],
            style_profile={},
            pr_patterns={},
            kg_penalties=[],
            test_plan=[],
        )
        assert isinstance(sys_p, str) and len(sys_p) > 20

    def test_user_prompt_contains_repo_and_rca(self):
        """User prompt encodes the repo_id and rca_id for traceability."""
        _, user_p = _build_patch_prompt(
            repo_id="my-repo",
            rca_id="rca-99",
            trace_id="tr-42",
            linked_files=[],
            style_profile={},
            pr_patterns={},
            kg_penalties=[],
            test_plan=[],
        )
        assert "my-repo" in user_p
        assert "rca-99" in user_p

    def test_user_prompt_feedback_not_injected_by_builder(self):
        """_build_patch_prompt never injects critic feedback — that's the
        caller's job via _dynamic_sections."""
        _, user_p = _build_patch_prompt(
            repo_id="r3",
            rca_id="rca-3",
            trace_id="t3",
            linked_files=[],
            style_profile={},
            pr_patterns={},
            kg_penalties=[],
            test_plan=[],
            rca_summary="Some bug",
        )
        assert "Critic feedback" not in user_p
        assert "Static preverify feedback" not in user_p


# ─────────────────────────────────────────────────────────────────────────────
# PatchGenerator retry prefix stability (integration-style unit test)
# ─────────────────────────────────────────────────────────────────────────────

class TestPatchGenRetryPrefixStability:
    """Verify that within a single generate() call, the static prefix of the
    user message is byte-identical across both aroute calls, while attempt-1
    appends critic feedback as a suffix.

    Setup notes:
    - PatchGenerator(router=mock_router) with style_learner/pr_patterns/kg=None
      causes the internal _load_* helpers to return empty dicts/lists — no DB.
    - We patch module-level _critic_review / _run_static_preverify / get_settings
      / try_consume_llm_call to avoid all external I/O.
    """

    @pytest.mark.asyncio
    async def test_static_prefix_byte_identical_across_retries(self):
        from eden.patches.patch_generator import PatchGenerator

        call_prompts: list[str] = []

        async def _fake_aroute(task, prompt, **kwargs):
            call_prompts.append(prompt)
            return _make_response(_GOOD_DIFF)

        async def _fake_critic(router, candidate, *, org_id, rca_summary):
            # First aroute call → reject to trigger retry.
            if len(call_prompts) == 1:
                return {"passed": False, "reason": "diff_is_incomplete", "cost_usd": 0.0}
            # Second aroute call → accept.
            return {"passed": True, "reason": "", "cost_usd": 0.0}

        async def _fake_static_preverify(candidate, linked_files):
            return {"status": "passed"}

        mock_router = MagicMock()
        mock_router.aroute = _fake_aroute

        # All service deps None → _load_* return empty defaults, no DB needed.
        gen = PatchGenerator(router=mock_router)

        with (
            patch(
                "eden.patches.patch_generator._critic_review",
                side_effect=_fake_critic,
            ),
            patch(
                "eden.patches.patch_generator._run_static_preverify",
                side_effect=_fake_static_preverify,
            ),
            patch(
                "eden.improvement.sweep_budget.try_consume_llm_call",
                return_value=True,
            ),
            patch(
                "eden.config.get_settings",
                return_value=_fake_settings(),
            ),
        ):
            result = await gen.generate(
                org_id="org-1",
                repo_id="repo-x",
                rca_id="rca-1",
                trace_id="tr-1",
                linked_files=[{"path": "foo.py", "content": "old\n"}],
                rca_summary="bug in foo",
                test_plan=["test_foo"],
            )

        # Two aroute calls: attempt-0 + critic-retry (attempt-1).
        assert len(call_prompts) == 2, (
            f"Expected 2 aroute calls, got {len(call_prompts)}"
        )

        prompt0, prompt1 = call_prompts

        # Attempt-1 must be strictly longer (critic feedback appended).
        assert len(prompt1) > len(prompt0), (
            "Retry prompt must be longer than initial prompt (critic feedback appended)"
        )

        # The static prefix (full text of attempt-0) must be byte-identical
        # at the start of attempt-1 — this is the L5 cache-hit guarantee.
        assert prompt1.startswith(prompt0), (
            "Static prefix of attempt-0 must be a byte-identical prefix of attempt-1\n"
            f"attempt-0 tail: {prompt0[-100:]!r}\n"
            f"attempt-1 head at same offset: {prompt1[len(prompt0)-100:len(prompt0)+50]!r}"
        )

        # The appended section must contain the critic feedback keyword.
        suffix = prompt1[len(prompt0):]
        assert "Critic feedback" in suffix, (
            f"Expected 'Critic feedback' in suffix, got: {suffix[:200]!r}"
        )

    @pytest.mark.asyncio
    async def test_static_preverify_feedback_also_in_suffix(self):
        """Static-preverify feedback on attempt-0 also lands in _dynamic_sections,
        not mutated into _static_prompt."""
        from eden.patches.patch_generator import PatchGenerator

        call_prompts: list[str] = []
        preverify_call_count = [0]

        async def _fake_aroute(task, prompt, **kwargs):
            call_prompts.append(prompt)
            return _make_response(_GOOD_DIFF)

        async def _fake_critic(router, candidate, *, org_id, rca_summary):
            # Always pass the critic so static preverify runs.
            return {"passed": True, "reason": "", "cost_usd": 0.0}

        async def _fake_static_preverify(candidate, linked_files):
            preverify_call_count[0] += 1
            if preverify_call_count[0] == 1:
                # First time: fail with feedback to trigger retry.
                return {"status": "failed", "feedback": "syntax_error_on_line_5"}
            return {"status": "passed"}

        mock_router = MagicMock()
        mock_router.aroute = _fake_aroute

        gen = PatchGenerator(router=mock_router)

        with (
            patch(
                "eden.patches.patch_generator._critic_review",
                side_effect=_fake_critic,
            ),
            patch(
                "eden.patches.patch_generator._run_static_preverify",
                side_effect=_fake_static_preverify,
            ),
            patch(
                "eden.improvement.sweep_budget.try_consume_llm_call",
                return_value=True,
            ),
            patch(
                "eden.config.get_settings",
                return_value=_fake_settings(),
            ),
        ):
            await gen.generate(
                org_id="org-2",
                repo_id="repo-y",
                rca_id="rca-2",
                trace_id="tr-2",
                linked_files=[],
                rca_summary="err",
                test_plan=[],
            )

        assert len(call_prompts) == 2
        prompt0, prompt1 = call_prompts
        assert prompt1.startswith(prompt0), "Static prefix must be byte-identical"
        suffix = prompt1[len(prompt0):]
        assert "Static preverify feedback" in suffix


# ─────────────────────────────────────────────────────────────────────────────
# patch_gen_model_override config plumbing
# ─────────────────────────────────────────────────────────────────────────────

class TestPatchGenModelOverridePlumbing:
    @pytest.mark.asyncio
    async def test_model_override_empty_sets_empty_on_task(self):
        """When patch_gen_model_override is empty, PipelineTask.model_override
        is empty and the normal aroute tier-selection path is used."""
        from eden.optimization.model_router import PipelineTask

        captured_tasks: list[PipelineTask] = []

        async def _capture_aroute(task, prompt, **kwargs):
            captured_tasks.append(task)
            return _make_response()

        mock_router = MagicMock()
        mock_router.aroute = _capture_aroute

        from eden.patches.patch_generator import PatchGenerator

        gen = PatchGenerator(router=mock_router)

        async def _critic_pass(router, candidate, *, org_id, rca_summary):
            return {"passed": True, "reason": "", "cost_usd": 0.0}

        async def _preverify_pass(candidate, linked_files):
            return {"status": "passed"}

        with (
            patch("eden.patches.patch_generator._critic_review", side_effect=_critic_pass),
            patch("eden.patches.patch_generator._run_static_preverify", side_effect=_preverify_pass),
            patch("eden.improvement.sweep_budget.try_consume_llm_call", return_value=True),
            patch(
                "eden.config.get_settings",
                return_value=_fake_settings(patch_gen_model_override=""),
            ),
        ):
            await gen.generate(
                org_id="org-3",
                repo_id="repo-a",
                rca_id="rca-3",
                trace_id="tr-3",
                linked_files=[],
                rca_summary="err",
                test_plan=[],
            )

        assert len(captured_tasks) == 1
        assert captured_tasks[0].model_override == "", (
            f"Expected empty model_override, got {captured_tasks[0].model_override!r}"
        )

    @pytest.mark.asyncio
    async def test_model_override_set_propagates_to_task(self):
        """When patch_gen_model_override is non-empty, the value propagates
        to PipelineTask.model_override so ModelRouter forces that model."""
        from eden.optimization.model_router import PipelineTask

        captured_tasks: list[PipelineTask] = []

        async def _capture_aroute(task, prompt, **kwargs):
            captured_tasks.append(task)
            return _make_response()

        mock_router = MagicMock()
        mock_router.aroute = _capture_aroute

        from eden.patches.patch_generator import PatchGenerator

        gen = PatchGenerator(router=mock_router)

        async def _critic_pass(router, candidate, *, org_id, rca_summary):
            return {"passed": True, "reason": "", "cost_usd": 0.0}

        async def _preverify_pass(candidate, linked_files):
            return {"status": "passed"}

        with (
            patch("eden.patches.patch_generator._critic_review", side_effect=_critic_pass),
            patch("eden.patches.patch_generator._run_static_preverify", side_effect=_preverify_pass),
            patch("eden.improvement.sweep_budget.try_consume_llm_call", return_value=True),
            patch(
                "eden.config.get_settings",
                return_value=_fake_settings(patch_gen_model_override="claude-haiku-4-5"),
            ),
        ):
            await gen.generate(
                org_id="org-4",
                repo_id="repo-b",
                rca_id="rca-4",
                trace_id="tr-4",
                linked_files=[],
                rca_summary="err",
                test_plan=[],
            )

        assert len(captured_tasks) == 1
        assert captured_tasks[0].model_override == "claude-haiku-4-5", (
            f"Expected 'claude-haiku-4-5', got {captured_tasks[0].model_override!r}"
        )
