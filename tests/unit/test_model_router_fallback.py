"""Session 11 tests — Model router fallback chain (S-21).

The audit bug: ``src/eden/optimization/model_router.py:aroute()``
used ``lambda: self.llm_client.call(..., model=model, ...)`` inside
``run_in_executor``. Python's late-binding closure semantics mean
``model`` is resolved when the lambda runs, not when it's defined —
so every fallback attempt resolved ``model`` to the LAST item in the
``for model in models:`` loop. The fallback chain effectively called
the same (failing) model N times before raising.

Fix: ``lambda m=model: ...`` binds ``model`` at lambda-definition
time (Python's default-argument early-binding trick).
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── Module-level sanity: late-binding vs early-binding ─────────
class TestLambdaBindingSemantics:
    """Sanity checks that the post-fix pattern actually behaves
    the way we expect. If Python's closure semantics ever change,
    this test breaks loudly before the audit regression does.
    """

    def test_default_arg_captures_value_at_def_time(self) -> None:
        """``lambda m=x: m`` captures ``x`` AT DEFINITION TIME —
        each iteration of the loop produces a fresh lambda with
        its own bound value.
        """
        results = []
        for x in ["a", "b", "c"]:
            def f(m=x):
                return m
            results.append(f())
        assert results == ["a", "b", "c"]

    def test_bare_lambda_resolves_late(self) -> None:
        """Demonstrates the pre-fix bug: bare ``lambda: x``
        resolves ``x`` LATE (at call time), so every iteration
        of the loop sees the LAST value of ``x`` once the
        lambdas are invoked AFTER the loop ends. This is the
        shape of the S-21 bug — ``run_in_executor`` calls
        the lambda later, not immediately.
        """
        # The closure trap: ``x`` is a single name, reassigned
        # each iteration. All bare lambdas reference THE SAME
        # name. If invoked AFTER the loop, they all see the
        # last value.
        lambdas = []
        # This test DELIBERATELY demonstrates the late-binding closure trap;
        # the loop variable capture is the subject under test.
        for x in ["a", "b", "c"]:
            lambdas.append(lambda: x)  # noqa: B023
        # Call after the loop — all lambdas see x=='c'.
        results = [f() for f in lambdas]
        assert results == ["c", "c", "c"], (
            f"Expected late-binding to collapse to the last "
            f"value; got {results}"
        )


# ─── S-21: aroute fallback chain tries every model ─────────────
class TestS21ModelRouterFallbackChain:
    """End-to-end: the async router must try each model in the
    tier's list, not just the last one.
    """

    @pytest.mark.asyncio
    async def test_arity_does_not_collapse_to_last_model(self) -> None:
        """Pre-fix bug: every fallback attempt resolved to
        ``models[-1]``. Post-fix: each call carries its own
        model. We force every model to fail validation so the
        chain walks the full T1 list.
        """
        from eden.optimization.model_router import (
            TIER_MODELS,
            ModelRouter,
            ModelTier,
            PipelineTask,
        )

        router = ModelRouter()

        # Mock the LLM client to capture what model name arrives.
        captured_models: list[str] = []

        class _Usage:
            total_tokens = 100

        class _Response:
            def __init__(self, model: str):
                self.model = model
                self.usage = _Usage()

        def _fake_call(*, model: str, **kwargs):
            captured_models.append(model)
            return _Response(model=model)

        router.llm_client.call = MagicMock(side_effect=_fake_call)
        # Validator: always FAIL so the chain walks every model
        # in T1, then escalates to T2, T3, T4 — we just assert
        # the T1 set was walked.
        router.validator.validate = AsyncMock(
            return_value=MagicMock(passed=False, reason="forced fail")
        )
        router.classifier.classify = AsyncMock(
            return_value=MagicMock(tier=ModelTier.T1)
        )

        task = PipelineTask(
            agent="test-agent",
            description="trivial task",
        )

        # Will raise MaxRetriesExceededError since no model passes.
        from eden.optimization.model_router import MaxRetriesExceededError
        with pytest.raises(MaxRetriesExceededError):
            await router.aroute(task, prompt="hello")

        # Every model in T1 must have been tried, in order.
        expected_t1 = list(TIER_MODELS[ModelTier.T1])
        assert captured_models[: len(expected_t1)] == expected_t1, (
            f"S-21 regression: T1 fallback chain did not try every "
            f"model. Expected {expected_t1}, got "
            f"{captured_models[:len(expected_t1)]}. Likely late-"
            f"binding lambda bug is back."
        )

    @pytest.mark.asyncio
    async def test_each_model_passed_individually(self) -> None:
        """A more targeted check: even if the chain short-circuits
        on the first success, we capture the FIRST model's name
        correctly — not the last one in the list.
        """
        from eden.optimization.model_router import (
            TIER_MODELS,
            ModelRouter,
            ModelTier,
            PipelineTask,
        )

        router = ModelRouter()

        captured: list[str] = []

        class _Response:
            def __init__(self, m: str):
                self.model = m
                self.usage = MagicMock(total_tokens=10)

        def _fake_call(*, model: str, **kwargs):
            captured.append(model)
            return _Response(model)

        router.llm_client.call = MagicMock(side_effect=_fake_call)
        router.validator.validate = AsyncMock(
            return_value=MagicMock(passed=True)
        )
        router.classifier.classify = AsyncMock(
            return_value=MagicMock(tier=ModelTier.T1)
        )

        task = PipelineTask(agent="agent-x", description="trivial")
        await router.aroute(task, prompt="hi")

        # First model tried = first model in T1 (NOT the last).
        assert captured[0] == TIER_MODELS[ModelTier.T1][0], (
            f"S-21 regression: first call used model={captured[0]!r}, "
            f"expected {TIER_MODELS[ModelTier.T1][0]!r}"
        )

    @pytest.mark.asyncio
    async def test_lambda_uses_default_arg_binding_pattern(self) -> None:
        """Static check: the production async path binds ``model`` via a
        default arg (``lambda m=model`` or ``def _call_routed(m: str = model)``),
        NOT bare ``lambda: ...``. Regress this and the S-21 fix is gone.
        """
        from pathlib import Path

        src = Path(
            "src/eden/optimization/model_router.py"
        ).read_text()
        has_default_binding = (
            "lambda m=model:" in src
            or "def _call_routed(m: str = model)" in src
        )
        assert has_default_binding, (
            "S-21 regression: default-arg model binding not found — "
            "late-binding for-loop bug is back"
        )
        # The pre-fix pattern must NOT appear in the async path.
        # We look for ``run_in_executor`` followed by ``lambda:``
        # without a default arg (a bare ``lambda: self.llm_client``).
        bad_pattern_lines = []
        in_run_in_executor = False
        for ln, line in enumerate(src.splitlines(), 1):
            if "run_in_executor" in line:
                in_run_in_executor = True
            if in_run_in_executor and "lambda:" in line and "m=model" not in line:
                bad_pattern_lines.append((ln, line.strip()))
            if in_run_in_executor and ")" in line and "run_in_executor" not in line:
                in_run_in_executor = False
        assert not bad_pattern_lines, (
            f"S-21 regression: bare 'lambda:' found inside "
            f"run_in_executor block at {bad_pattern_lines}"
        )
