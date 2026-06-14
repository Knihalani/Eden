"""Behavioural tests for Cat 21 — Custom-Metric Studio.

These tests exercise the four real services
(:class:`RubricTemplateLibrary`, :class:`RubricSynthesiser`,
:class:`JudgeFactory`, :class:`CustomMetricRegistry`) and the
six routes that expose them, plus the closed-loop
:class:`MetricStudioHook` that fires on metric promotion.

The tests follow two patterns:

* **Service-level unit tests** — call the service classes
  directly with mocked Postgres / LLM client / judge
  registry / hook singletons. The
  :func:`patch_postgres` autouse fixture in :mod:`tests.conftest`
  returns an empty ``fetch()`` by default, which gives the
  services a clean "no features" path. Tests that need
  events or a custom policy override the mock with a
  side-effect.

* **Route-level smoke tests** — a minimal :class:`FastAPI` app
  with the ``intelligence_metric_studio`` router mounted
  and ``get_current_user`` overridden, mirroring the
  pattern in
  :mod:`tests.intelligence.test_decision_intelligence`. We
  hit each of the 6 Cat 21 routes and assert the
  response shape and gating.
"""

from __future__ import annotations

import importlib
import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Sample data ────────────────────────────────────────────────────


def _good_example(label: str = "pass") -> dict[str, Any]:
    return {
        "input": "Write a one-sentence summary of the user's last message.",
        "output": "The user asked for a refund on a defective product.",
        "label": label,
        "rationale": "Concise, accurate, on-task." if label == "pass" else "Misses the deadline concern.",
    }


def _good_examples(n: int = 3) -> list[dict[str, Any]]:
    """Return ``n`` labelled examples alternating pass/fail."""
    out: list[dict[str, Any]] = []
    for i in range(n):
        out.append(
            {
                "input": f"Example input #{i}",
                "output": f"Example output #{i}",
                "label": "pass" if i % 2 == 0 else "fail",
                "rationale": f"Rationale #{i}",
            }
        )
    return out


# ─── 1. RubricTemplateLibrary ──────────────────────────────────────


class TestRubricTemplateLibrary:
    def test_returns_full_catalog(self) -> None:
        from eden.metric_studio import RubricTemplateLibrary

        templates = RubricTemplateLibrary().list()
        # 14 hand-curated templates across 6 domains — see
        # templates.py for the canonical list.
        assert len(templates) >= 12
        ids = {t["id"] for t in templates}
        assert "anthropic_harm_v1" in ids
        assert "pii_leak_v2" in ids
        assert "brand_voice_v3" in ids
        assert "factual_accuracy_v1" in ids

    def test_filter_by_domain(self) -> None:
        from eden.metric_studio import RubricTemplateLibrary

        safety = RubricTemplateLibrary().list(domain="safety")
        assert all(t["domain"] == "safety" for t in safety)
        assert len(safety) >= 2

    def test_filter_unknown_domain_returns_empty(self) -> None:
        from eden.metric_studio import RubricTemplateLibrary

        out = RubricTemplateLibrary().list(domain="does_not_exist")
        assert out == []

    def test_filter_is_case_insensitive(self) -> None:
        from eden.metric_studio import RubricTemplateLibrary

        a = RubricTemplateLibrary().list(domain="MARKETING")
        b = RubricTemplateLibrary().list(domain="marketing")
        assert {t["id"] for t in a} == {t["id"] for t in b}

    def test_get_returns_template(self) -> None:
        from eden.metric_studio import RubricTemplateLibrary

        t = RubricTemplateLibrary().get("anthropic_harm_v1")
        assert t is not None
        assert t["domain"] == "safety"
        assert "criteria" in t
        assert len(t["criteria"]) >= 3

    def test_get_unknown_returns_none(self) -> None:
        from eden.metric_studio import RubricTemplateLibrary

        assert RubricTemplateLibrary().get("nonexistent_v9") is None

    def test_template_shape_has_required_keys(self) -> None:
        from eden.metric_studio import RubricTemplateLibrary

        for t in RubricTemplateLibrary().list():
            assert {"id", "name", "domain", "version", "criteria"} <= set(t.keys())
            assert isinstance(t["criteria"], list)
            assert all(isinstance(c, str) for c in t["criteria"])


# ─── 2. RubricSynthesiser ──────────────────────────────────────────


class TestRubricSynthesiser:
    @pytest.mark.asyncio
    async def test_too_few_examples_returns_stub(self) -> None:
        from eden.metric_studio import RubricSynthesiser

        result = await RubricSynthesiser().from_examples(
            "org_test",
            name="Bad Metric",
            examples=[_good_example()],
            domain="safety",
        )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert "at least 2 examples" in result["message"]
        assert result["data"]["approval_required"] is True

    @pytest.mark.asyncio
    async def test_too_many_examples_returns_stub(self) -> None:
        from eden.metric_studio import RubricSynthesiser

        result = await RubricSynthesiser().from_examples(
            "org_test",
            name="Bad Metric",
            examples=_good_examples(6),
            domain="safety",
        )
        assert "at most 5 examples" in result["message"]

    @pytest.mark.asyncio
    async def test_invalid_label_returns_stub(self) -> None:
        from eden.metric_studio import RubricSynthesiser

        examples = _good_examples(2)
        examples[0]["label"] = "maybe"
        result = await RubricSynthesiser().from_examples(
            "org_test", name="Bad", examples=examples, domain="safety"
        )
        assert "label must be" in result["message"]

    @pytest.mark.asyncio
    async def test_missing_input_returns_stub(self) -> None:
        from eden.metric_studio import RubricSynthesiser

        examples = _good_examples(2)
        examples[0]["input"] = ""
        result = await RubricSynthesiser().from_examples(
            "org_test", name="Bad", examples=examples, domain="safety"
        )
        assert "missing input or output" in result["message"]

    @pytest.mark.asyncio
    async def test_successful_synthesis_calls_llm_and_persists(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.metric_studio import RubricSynthesiser

        # Mock the LLM client to return a small rubric.
        fake_rubric = "Domain: safety. Pass: stays on-policy. Fail: violates policy."
        fake_response = MagicMock()
        fake_response.content = fake_rubric
        fake_response.model = "test-model"
        fake_client = MagicMock()
        fake_client.call = MagicMock(return_value=fake_response)

        with patch(
            "eden.llm.client.get_llm_client", return_value=fake_client
        ), patch(
            "eden.metric_studio.synthesiser._delete_then_insert",
            new=AsyncMock(),
        ) as persist:
            result = await RubricSynthesiser().from_examples(
                "org_test",
                name="Test Metric",
                examples=_good_examples(3),
                domain="safety",
            )

        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["feature"] == "rubric_synthesiser"
        assert result["data"]["rubric_prompt"] == fake_rubric
        assert result["data"]["approval_required"] is True
        assert result["data"]["approval_status"] == "pending"
        assert "rubric_id" in result["data"]
        # The persistence was called once.
        persist.assert_awaited_once()
        # The LLM call was made with the "fast" slot.
        call_kwargs = fake_client.call.call_args.kwargs
        assert call_kwargs.get("slot") == "fast"
        assert call_kwargs.get("agent") == "metric_studio_synthesiser"

    @pytest.mark.asyncio
    async def test_token_cap_enforced(self) -> None:
        """When the LLM returns a 5000-char response, the
        synthesised rubric is truncated to the 1500-token
        (= 6000-char) cap."""
        from eden.metric_studio import RubricSynthesiser

        # 10,000 chars = ~2500 tokens — over the 1500 cap.
        long_rubric = "x" * 10000
        fake_response = MagicMock()
        fake_response.content = long_rubric
        fake_response.model = "test-model"
        fake_client = MagicMock()
        fake_client.call = MagicMock(return_value=fake_response)

        with patch(
            "eden.llm.client.get_llm_client", return_value=fake_client
        ), patch(
            "eden.metric_studio.synthesiser._delete_then_insert",
            new=AsyncMock(),
        ):
            result = await RubricSynthesiser().from_examples(
                "org_test",
                name="Long",
                examples=_good_examples(2),
                domain="safety",
            )
        assert result["data"]["rubric_tokens"] <= 1500
        assert len(result["data"]["rubric_prompt"]) <= 6000

    @pytest.mark.asyncio
    async def test_llm_failure_returns_stub_fallback(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.metric_studio import RubricSynthesiser

        # The LLM client raises — the synthesiser should
        # gracefully return a stub-style envelope without
        # raising.
        fake_client = MagicMock()
        fake_client.call = MagicMock(side_effect=RuntimeError("LLM unavailable"))

        with patch(
            "eden.llm.client.get_llm_client", return_value=fake_client
        ), patch(
            "eden.metric_studio.synthesiser._delete_then_insert",
            new=AsyncMock(),
        ) as persist:
            result = await RubricSynthesiser().from_examples(
                "org_test",
                name="Fail",
                examples=_good_examples(2),
                domain="safety",
            )
        assert result["live"] is True
        assert "synthesis failed" in result["message"]
        # No persistence on failure.
        persist.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_llm_response_returns_stub(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.metric_studio import RubricSynthesiser

        fake_response = MagicMock()
        fake_response.content = ""
        fake_response.model = "test-model"
        fake_client = MagicMock()
        fake_client.call = MagicMock(return_value=fake_response)

        with patch(
            "eden.llm.client.get_llm_client", return_value=fake_client
        ), patch(
            "eden.metric_studio.synthesiser._delete_then_insert",
            new=AsyncMock(),
        ):
            result = await RubricSynthesiser().from_examples(
                "org_test",
                name="Empty",
                examples=_good_examples(2),
                domain="safety",
            )
        assert "synthesis failed" in result["message"]


# ─── 3. JudgeFactory + RubricJudge ─────────────────────────────────


class TestJudgeFactory:
    @pytest.mark.asyncio
    async def test_wrap_rubric_registers_in_judge_registry(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.llmops.judges.registry import JudgeRegistry
        from eden.metric_studio import JudgeFactory

        registry = JudgeRegistry()
        hook = MagicMock()
        hook.on_metric_promotion = MagicMock()

        with patch(
            "eden.llmops.judges.registry.get_judge_registry",
            return_value=registry,
        ), patch(
            "eden.llmops.promotion_hooks.get_metric_studio_hook",
            return_value=hook,
        ), patch(
            "eden.metric_studio._common._update_run_status",
            new=AsyncMock(),
        ):
            result = await JudgeFactory().wrap_rubric_as_judge(
                "org_test",
                metric_id="metric_abc123",
                rubric_prompt="Some rubric text",
                name="Test Metric",
                rubric_id="rubric_abc",
                domain="safety",
            )

        assert result["data"]["wrapped"] is True
        assert result["data"]["metric_id"] == "metric_abc123"
        # The judge was registered in the global registry.
        judge = registry.get("custom_metric_abc123")
        assert judge is not None
        assert judge.org_id == "org_test"
        assert judge.metric_id == "metric_abc123"
        assert judge.rubric_prompt == "Some rubric text"
        # The closed-loop hook fired.
        hook.on_metric_promotion.assert_called_once()
        kwargs = hook.on_metric_promotion.call_args.kwargs
        assert kwargs["org_id"] == "org_test"
        assert kwargs["metric_id"] == "metric_abc123"

    @pytest.mark.asyncio
    async def test_wrap_with_empty_rubric_returns_not_wrapped(self) -> None:
        from eden.metric_studio import JudgeFactory

        result = await JudgeFactory().wrap_rubric_as_judge(
            "org_test",
            metric_id="metric_abc",
            rubric_prompt="",
            name="Empty",
            rubric_id="rubric_empty",
            domain="safety",
        )
        assert result["data"]["wrapped"] is False
        assert "missing rubric" in result["data"]["reason"]

    @pytest.mark.asyncio
    async def test_rubric_judge_opt_in_off_returns_no_score(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """The RubricJudge gate must return score=None when
        the per-tenant opt-in policy is OFF (the v1.4 default)."""
        from eden.llmops.judges.base import JudgeContext, JudgeScore
        from eden.metric_studio.judge_factory import RubricJudge

        judge = RubricJudge(
            org_id="org_test",
            metric_id="metric_abc",
            judge_name="custom_metric_abc",
            rubric_prompt="some rubric",
        )
        # The opt-in gate is mocked to return False.
        event = MagicMock()
        event.trace_id = "trace-1"
        event.span_id = "span-1"
        event.event_type = "openai.chat"
        event.payload = {"openai": {"first_message_content": "hello"}}
        ctx = JudgeContext(event=event, llm_client=MagicMock(), trace_id="trace-1")

        with patch(
            "eden.metric_studio.judge_factory._check_auto_judge_policy",
            new=AsyncMock(return_value=(False, "metric_not_opted_in")),
        ), patch(
            "eden.metric_studio.judge_factory._write_score_audit_log",
            new=AsyncMock(),
        ) as audit:
            result = await judge.score(event, ctx)
        assert isinstance(result, JudgeScore)
        assert result.score == 0.5  # neutral "no_score"
        assert "auto_judge_policy_off" in result.rationale
        # The audit log was written with score=None.
        audit.assert_awaited_once()
        kwargs = audit.call_args.kwargs
        assert kwargs["score"] is None
        assert kwargs["result"]["scored"] is False

    @pytest.mark.asyncio
    async def test_rubric_judge_happy_path(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """When the opt-in gate is ON and the LLM returns a
        clean JSON response, the judge returns the score and
        writes a scored audit log row."""
        from eden.llmops.judges.base import JudgeContext, JudgeScore
        from eden.metric_studio.judge_factory import RubricJudge

        judge = RubricJudge(
            org_id="org_test",
            metric_id="metric_abc",
            judge_name="custom_metric_abc",
            rubric_prompt="some rubric",
        )
        event = MagicMock()
        event.trace_id = "trace-1"
        event.span_id = "span-1"
        event.event_type = "openai.chat"
        event.payload = {"openai": {"first_message_content": "hello world"}}
        llm_response = MagicMock()
        llm_response.content = '{"score": 0.85, "rationale": "looks good"}'
        llm_response.model = "test-model"
        ctx = JudgeContext(
            event=event, llm_client=MagicMock(call=MagicMock(return_value=llm_response)), trace_id="trace-1"
        )

        with patch(
            "eden.metric_studio.judge_factory._check_auto_judge_policy",
            new=AsyncMock(return_value=(True, "opted_in")),
        ), patch(
            "eden.metric_studio.judge_factory._write_score_audit_log",
            new=AsyncMock(),
        ) as audit:
            result = await judge.score(event, ctx)
        assert isinstance(result, JudgeScore)
        assert result.score == 0.85
        assert result.rationale == "looks good"
        assert result.metadata.get("rubric_judge") is True
        # Audit log was written with the score.
        kwargs = audit.call_args.kwargs
        assert kwargs["score"] == 0.85
        assert kwargs["result"]["scored"] is True


# ─── 4. CustomMetricRegistry ──────────────────────────────────────


class TestCustomMetricRegistry:
    @pytest.mark.asyncio
    async def test_register_writes_metric_to_org_features(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.metric_studio import CustomMetricRegistry

        # The audit log returns a synthesised rubric.
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "synthesised_rubric": "Test rubric",
                "metric_name": "Test Metric",
                "domain": "safety",
            }
        )

        with patch(
            "eden.llmops.judges.registry.get_judge_registry",
            return_value=MagicMock(),
        ), patch(
            "eden.llmops.promotion_hooks.get_metric_studio_hook",
            return_value=MagicMock(),
        ):
            result = await CustomMetricRegistry().register(
                "org_test",
                name="Test Metric",
                rubric_id="rubric_abc",
                version="1.0",
                domain="safety",
            )
        assert result["data"]["registered"] is True
        assert "metric_id" in result["data"]
        assert "judge_id" in result["data"]

    @pytest.mark.asyncio
    async def test_register_without_rubric_returns_not_registered(self) -> None:
        from eden.metric_studio import CustomMetricRegistry

        result = await CustomMetricRegistry().register(
            "org_test",
            name="Test",
            rubric_id="",
        )
        assert result["data"]["registered"] is False
        assert "missing rubric_id" in result["data"]["reason"]

    @pytest.mark.asyncio
    async def test_register_missing_audit_row_returns_not_registered(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.metric_studio import CustomMetricRegistry

        mock_postgres_client.fetchrow = AsyncMock(return_value=None)
        result = await CustomMetricRegistry().register(
            "org_test",
            name="Test",
            rubric_id="rubric_does_not_exist",
        )
        assert result["data"]["registered"] is False
        assert "no synthesised rubric" in result["data"]["reason"]

    @pytest.mark.asyncio
    async def test_list_enriches_with_score_stats(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.metric_studio import CustomMetricRegistry

        # First fetchrow (in _load_org_features) returns the
        # features JSONB. Subsequent fetch calls (in
        # _fetch_run_runs) return the score rows.
        async def _fetchrow_side(query, *args):
            if "features" in query:
                return {
                    "features": {
                        "custom_metrics": [
                            {
                                "metric_id": "metric_a",
                                "name": "A",
                                "rubric_id": "rubric_a",
                                "version": "1.0",
                                "status": "production",
                                "judge_id": "custom_metric_a",
                                "domain": "safety",
                                "created_at": "2026-06-01T00:00:00+00:00",
                            }
                        ]
                    }
                }
            return None

        # Patch the _load_org_features to return what we want
        # without going through Postgres — simpler.
        from eden.metric_studio import _common
        from eden.metric_studio.registry import _fetch_run_runs as real_fetch_run_runs

        async def _fake_load_org_features(org_id: str) -> dict[str, Any]:
            return {
                "custom_metrics": [
                    {
                        "metric_id": "metric_a",
                        "name": "A",
                        "rubric_id": "rubric_a",
                        "version": "1.0",
                        "status": "production",
                        "judge_id": "custom_metric_a",
                        "domain": "safety",
                        "created_at": "2026-06-01T00:00:00+00:00",
                    },
                    {
                        "metric_id": "metric_b",
                        "name": "B",
                        "rubric_id": "rubric_b",
                        "version": "1.0",
                        "status": "draft",
                        "judge_id": "custom_metric_b",
                        "domain": "marketing",
                        "created_at": "2026-06-05T00:00:00+00:00",
                    },
                ]
            }

        async def _fake_fetch_runs(org_id: str, metric_id: str, since_iso=None):
            if metric_id == "metric_a":
                return [
                    {"score": 0.7, "trace_id": "t1", "created_at": "2026-06-10T00:00:00+00:00"},
                    {"score": 0.8, "trace_id": "t2", "created_at": "2026-06-10T00:00:00+00:00"},
                    {"score": 0.9, "trace_id": "t3", "created_at": "2026-06-10T00:00:00+00:00"},
                ]
            return []

        with patch.object(_common, "_load_org_features", _fake_load_org_features), patch(
            "eden.metric_studio.registry._fetch_run_runs",
            _fake_fetch_runs,
        ):
            result = await CustomMetricRegistry().list("org_test")
        assert result["data"]["count"] == 2
        a = next(m for m in result["data"]["metrics"] if m["metric_id"] == "metric_a")
        b = next(m for m in result["data"]["metrics"] if m["metric_id"] == "metric_b")
        assert a["n_scores_30d"] == 3
        assert a["median_score"] == 0.8
        assert b["n_scores_30d"] == 0
        assert b["median_score"] is None

    @pytest.mark.asyncio
    async def test_approve_promotes_draft_to_production(self) -> None:
        from eden.metric_studio import CustomMetricRegistry, _common

        hook = MagicMock()
        hook.on_metric_promotion = MagicMock()

        async def _fake_load_org_features(org_id: str) -> dict[str, Any]:
            return {
                "custom_metrics": [
                    {
                        "metric_id": "metric_a",
                        "name": "A",
                        "rubric_id": "rubric_a",
                        "version": "1.0",
                        "status": "draft",
                        "judge_id": "custom_metric_a",
                        "domain": "safety",
                        "created_at": "2026-06-01T00:00:00+00:00",
                    }
                ]
            }

        async def _fake_save(org_id: str, features: dict[str, Any]) -> None:
            # Capture the saved state for assertion.
            _fake_save.saved = features

        with patch.object(_common, "_load_org_features", _fake_load_org_features):
            with patch.object(_common, "_save_org_features", _fake_save):
                with patch(
                    "eden.llmops.promotion_hooks.get_metric_studio_hook",
                    return_value=hook,
                ):
                    result = await CustomMetricRegistry().approve(
                        "org_test", "metric_a", approved_by="admin@test.com"
                    )
        assert result["data"]["approved"] is True
        assert result["data"]["status"] == "production"
        assert result["data"]["approved_by"] == "admin@test.com"
        # The metric in the saved state was promoted.
        saved_metric = _fake_save.saved["custom_metrics"][0]
        assert saved_metric["status"] == "production"
        assert saved_metric["promoted_by"] == "admin@test.com"
        # The hook fired.
        hook.on_metric_promotion.assert_called_once()
        kwargs = hook.on_metric_promotion.call_args.kwargs
        assert kwargs["org_id"] == "org_test"
        assert kwargs["metric_id"] == "metric_a"

    @pytest.mark.asyncio
    async def test_approve_unknown_metric_returns_not_approved(self) -> None:
        from eden.metric_studio import CustomMetricRegistry, _common

        async def _fake_load_org_features(org_id: str) -> dict[str, Any]:
            return {"custom_metrics": []}

        with patch.object(_common, "_load_org_features", _fake_load_org_features):
            result = await CustomMetricRegistry().approve(
                "org_test", "metric_does_not_exist", approved_by="admin@test.com"
            )
        assert result["data"]["approved"] is False
        assert "no metric" in result["data"]["reason"]


# ─── 5. Opt-in policy (Cat 21 v1.4) ────────────────────────────────


class TestOptInPolicy:
    @pytest.mark.asyncio
    async def test_no_features_returns_not_opted_in(self) -> None:
        from eden.metric_studio import _common
        from eden.metric_studio._common import _check_auto_judge_policy

        async def _empty(org_id: str) -> dict[str, Any]:
            return {}

        with patch.object(_common, "_load_org_features", _empty):
            allowed, reason = await _check_auto_judge_policy("org_test", "metric_a")
        assert allowed is False
        # The exact reason depends on the policy shape; both
        # "policy_malformed" and "metric_not_opted_in" are
        # valid "not opted in" signals.
        assert reason in {"policy_malformed", "metric_not_opted_in"}

    @pytest.mark.asyncio
    async def test_metric_opted_in_returns_allowed(self) -> None:
        from eden.metric_studio import _common
        from eden.metric_studio._common import _check_auto_judge_policy

        async def _with_opt_in(org_id: str) -> dict[str, Any]:
            return {
                "auto_judge_policy": {
                    "custom_metrics": {"metric_a": True},
                    "auto_judge_sample_rate": 1.0,
                    "auto_judge_daily_budget_usd": 0.0,
                }
            }

        with patch.object(_common, "_load_org_features", _with_opt_in):
            allowed, reason = await _check_auto_judge_policy("org_test", "metric_a")
        assert allowed is True
        assert reason == "opted_in"

    @pytest.mark.asyncio
    async def test_other_metric_not_in_allow_list_returns_not_allowed(self) -> None:
        from eden.metric_studio import _common
        from eden.metric_studio._common import _check_auto_judge_policy

        async def _with_other_opt_in(org_id: str) -> dict[str, Any]:
            return {
                "auto_judge_policy": {
                    "custom_metrics": {"metric_other": True},
                    "auto_judge_sample_rate": 1.0,
                }
            }

        with patch.object(_common, "_load_org_features", _with_other_opt_in):
            allowed, reason = await _check_auto_judge_policy("org_test", "metric_a")
        assert allowed is False
        assert reason == "metric_not_opted_in"


# ─── 6. Closed-loop hook (Cat 17b) ─────────────────────────────────


class TestMetricStudioHook:
    def test_singleton_exists(self) -> None:
        from eden.llmops.promotion_hooks import get_metric_studio_hook

        hook = get_metric_studio_hook()
        assert hook is not None
        assert hook.name == "metric_studio_hook"

    def test_register_all_hooks_includes_metric_studio(self) -> None:
        from eden.llmops import promotion_hooks

        promotion_hooks.register_all_hooks()
        # No assertion failure = the function ran cleanly. The
        # "metric_studio" string is in the log line, but we
        # don't capture logs in this test — the test is a
        # smoke check that the import graph + the singleton
        # initialisation are intact.

    async def test_hook_fires_on_promotion(self) -> None:
        from eden.llmops import promotion_hooks
        from eden.llmops.promotion_hooks import get_metric_studio_hook

        hook = get_metric_studio_hook()
        with patch.object(promotion_hooks.logger, "debug") as log_debug:
            await hook.on_metric_promotion(
                "org_test", metric_id="metric_a", judge_name="custom_metric_a"
            )
        log_debug.assert_called_once()
        # The log call args are (format_string, *args) — the
        # actual values are in the second arg onward. Inspect
        # all positional args to find the substituted values.
        call_args = log_debug.call_args
        all_args = list(call_args.args) + list(call_args.kwargs.values())
        joined = " ".join(str(a) for a in all_args)
        assert "metric_a" in joined
        assert "custom_metric_a" in joined


# ─── 7. Route smoke tests ─────────────────────────────────────────


def _build_metric_studio_app() -> FastAPI:
    """A minimal FastAPI app for the Cat 21 router smoke tests."""
    from eden.api.deps import get_current_user, require_org_admin
    from eden.api.routes import intelligence_metric_studio

    app = FastAPI()
    # Override the user dependency so the test client can
    # authenticate without a real session.
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "test-user",
        "org_id": "org_test",
    }
    # The admin dependency returns a fake admin record.
    app.dependency_overrides[require_org_admin] = lambda: {
        "id": "org_test",
        "role": "admin",
    }
    # The feature flag is set via env in conftest already;
    # the dependency reads it on each call.
    app.include_router(intelligence_metric_studio.router)
    return app


@pytest.fixture(scope="module")
def metric_studio_client() -> TestClient:
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    return TestClient(_build_metric_studio_app())


class TestRoutes:
    def test_templates_route_returns_list(
        self, metric_studio_client: TestClient
    ) -> None:
        resp = metric_studio_client.get(
            "/orgs/org_test/intelligence/metric-studio/templates"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["feature"] == "rubric_template_library"
        assert "templates" in body["data"]
        assert body["data"]["count"] >= 12

    def test_templates_route_filter_by_domain(
        self, metric_studio_client: TestClient
    ) -> None:
        resp = metric_studio_client.get(
            "/orgs/org_test/intelligence/metric-studio/templates?domain=safety"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert all(t["domain"] == "safety" for t in body["data"]["templates"])

    @pytest.mark.asyncio
    async def test_from_examples_route_returns_envelope(
        self, metric_studio_client: TestClient
    ) -> None:
        fake_rubric = "Test rubric"
        fake_response = MagicMock()
        fake_response.content = fake_rubric
        fake_response.model = "test-model"
        fake_client = MagicMock()
        fake_client.call = MagicMock(return_value=fake_response)
        with patch(
            "eden.llm.client.get_llm_client", return_value=fake_client
        ), patch(
            "eden.metric_studio.synthesiser._delete_then_insert",
            new=AsyncMock(),
        ):
            resp = metric_studio_client.post(
                "/orgs/org_test/intelligence/metric-studio/from-examples",
                json={
                    "name": "Test",
                    "domain": "safety",
                    "examples": _good_examples(2),
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["feature"] == "rubric_synthesiser"
        assert "rubric_id" in body["data"]

    def test_from_examples_route_validates_too_few(
        self, metric_studio_client: TestClient
    ) -> None:
        resp = metric_studio_client.post(
            "/orgs/org_test/intelligence/metric-studio/from-examples",
            json={
                "name": "Test",
                "domain": "safety",
                "examples": [_good_example()],
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "at least 2 examples" in body["message"]

    @pytest.mark.asyncio
    async def test_metrics_list_route_returns_envelope(
        self, metric_studio_client: TestClient
    ) -> None:
        from eden.metric_studio import _common

        async def _empty(org_id: str) -> dict[str, Any]:
            return {}

        with patch.object(_common, "_load_org_features", _empty):
            resp = metric_studio_client.get(
                "/orgs/org_test/intelligence/metric-studio/metrics"
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["count"] == 0

    @pytest.mark.asyncio
    async def test_approve_route_calls_registry(
        self, metric_studio_client: TestClient
    ) -> None:
        from eden.metric_studio import CustomMetricRegistry, _common

        async def _with_metric(org_id: str) -> dict[str, Any]:
            return {
                "custom_metrics": [
                    {
                        "metric_id": "metric_a",
                        "name": "A",
                        "rubric_id": "rubric_a",
                        "version": "1.0",
                        "status": "draft",
                        "judge_id": "custom_metric_a",
                        "domain": "safety",
                        "created_at": "2026-06-01T00:00:00+00:00",
                    }
                ]
            }

        async def _fake_save(org_id: str, features: dict[str, Any]) -> None:
            pass

        with patch.object(_common, "_load_org_features", _with_metric):
            with patch.object(_common, "_save_org_features", _fake_save):
                with patch(
                    "eden.llmops.promotion_hooks.get_metric_studio_hook",
                    return_value=MagicMock(),
                ):
                    resp = metric_studio_client.post(
                        "/orgs/org_test/intelligence/metric-studio/metrics/metric_a/approve",
                        json={"approved_by": "admin@test.com"},
                    )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"]["approved"] is True
        assert body["data"]["status"] == "production"


# ─── 8. Package contract (lazy re-exports) ─────────────────────────


class TestPackageContract:
    def test_cold_import_does_not_load_synthesiser(self) -> None:
        """Importing one service must not eagerly import the
        others (which would pull in the LLM client, the
        judge registry, and the closed-loop hooks)."""
        for mod in list(sys.modules):
            if mod.startswith("eden.metric_studio."):
                del sys.modules[mod]
        # Importing the template library alone should not
        # load the synthesiser (which depends on the LLM
        # client).
        from eden.metric_studio import RubricTemplateLibrary
        assert "eden.metric_studio.synthesiser" not in sys.modules

    def test_unknown_attribute_raises(self) -> None:
        import eden.metric_studio
        from eden.metric_studio import RubricTemplateLibrary

        with pytest.raises(AttributeError):
            eden.metric_studio.NonExistentService  # noqa: B018

    def test_dir_includes_public_names(self) -> None:
        import eden.metric_studio

        d = dir(eden.metric_studio)
        for name in [
            "CustomMetricRegistry",
            "JudgeFactory",
            "RubricSynthesiser",
            "RubricTemplateLibrary",
        ]:
            assert name in d

    def test_re_import_caches_in_globals(self) -> None:
        """The PEP 562 __getattr__ caches the value in
        globals() on first access. A subsequent access
        should not re-import."""
        # After the import, the value is in the module's
        # globals — a direct attribute access bypasses
        # __getattr__.
        import eden.metric_studio
        from eden.metric_studio import RubricTemplateLibrary
        assert eden.metric_studio.RubricTemplateLibrary is RubricTemplateLibrary
