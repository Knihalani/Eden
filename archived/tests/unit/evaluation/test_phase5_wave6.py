"""Phase 5 Wave 6 unit tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.evaluation.code_evaluator import CodeEvaluatorRunner, _validate_source
from eden.evaluation.online.scorer_cascade import OnlineScorerCascade
from eden.evaluation.online.slm_hook import score_with_slm
from eden.evaluation.production.sampler import ProductionEvalSampler


def test_code_evaluator_rejects_imports() -> None:
    with pytest.raises(ValueError, match="imports not allowed"):
        _validate_source("import os\n\ndef evaluate(p): return 1")


@pytest.mark.asyncio
async def test_code_evaluator_runs_user_function() -> None:
    source = "def evaluate(payload):\n    return {'score': 0.9, 'passed': True}"
    _validate_source(source)
    runner = CodeEvaluatorRunner()
    with (
        patch(
            "eden.evaluation.code_evaluator._exec_enabled",
            return_value=True,
        ),
        patch.object(runner, "_client", new_callable=AsyncMock) as mock_client,
    ):
        mock_client.return_value.fetchrow = AsyncMock(
            return_value={"source_code": source, "entrypoint": "evaluate"}
        )
        result = await runner.run("org1", "eval-id", {"text": "hello"})
    assert result is not None
    assert result["score"] == 0.9
    assert result["passed"] is True
    assert result["judge_tier"] == "code"


@pytest.mark.asyncio
async def test_code_evaluator_run_blocked_when_gate_off() -> None:
    """Default posture: exec is gated off until a real sandbox ships."""
    runner = CodeEvaluatorRunner()
    with patch(
        "eden.evaluation.code_evaluator._exec_enabled",
        return_value=False,
    ):
        result = await runner.run("org1", "eval-id", {"text": "hello"})
    assert result is None


@pytest.mark.asyncio
async def test_slm_hook_returns_none_when_llm_unavailable() -> None:
    with patch(
        "eden.autonomous._common._call_llm",
        new=AsyncMock(return_value=None),
    ):
        assert await score_with_slm("org", trace_id="t1", payload={"text": "x"}) is None


@pytest.mark.asyncio
async def test_scorer_cascade_no_fake_when_empty() -> None:
    cascade = OnlineScorerCascade()
    with patch.object(cascade, "_reuse_existing_scores", new_callable=AsyncMock, return_value=None):
        assert await cascade.score("org", trace_id="t1", span_id="s1") is None


@pytest.mark.asyncio
async def test_sampler_skips_without_rules_or_scores() -> None:
    sampler = ProductionEvalSampler()
    with patch.object(sampler, "_enabled", return_value=True):
        with patch.object(sampler, "_resolve_policy", new_callable=AsyncMock, return_value={"enabled": True, "sample_rate": 1.0}):
            with patch.object(sampler, "_budget_allows", new_callable=AsyncMock, return_value=True):
                with patch.object(sampler, "_score_trace", new_callable=AsyncMock, return_value=(0.0, False, 0.0)):
                    with patch.object(sampler, "_org_has_rules", new_callable=AsyncMock, return_value=False):
                        assert await sampler.maybe_score_trace("org", "trace-1") is None


@pytest.mark.asyncio
async def test_eval_to_shadow_enqueues_evidence_gate() -> None:
    from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

    link = EvalToGuardrailLink()
    with patch.object(link, "promote_to_guardrail", new_callable=AsyncMock) as mock_promote:
        mock_promote.return_value = {
            "status": "ok",
            "data": {"guardrail_policy_id": "pol-1", "judge_name": "hallucination"},
        }
        with patch("eden.promotion.evidence_gate.EvidenceGate.enqueue", new_callable=AsyncMock) as mock_eq:
            mock_eq.return_value = "cand-1"
            with patch("eden.llmops.learn_wiring.install_learn_filters"):
                with patch("eden.llmops.filters.guardrail.get_guardrail_filter") as mock_filt:
                    mock_filt.return_value = MagicMock(_policies={})
                    result = await link.promote_to_shadow(
                        "org", judge_name="hallucination", threshold=0.6
                    )
    assert result["status"] == "ok"
    assert result["data"]["enforcement_level"] == "shadow"
    mock_eq.assert_awaited_once()


def test_wave6_routes_mounted() -> None:
    from fastapi.routing import APIRoute

    from eden.api.routes import wave6_online

    paths = {r.path for r in wave6_online.router.routes if isinstance(r, APIRoute)}
    assert "/orgs/{org_id}/online-scoring/rules" in paths
    assert "/orgs/{org_id}/spans/{span_id}/scores" in paths
    assert "/orgs/{org_id}/ci-eval/run" in paths
    assert "/orgs/{org_id}/traces/{trace_id}/metadata" in paths
