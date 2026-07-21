"""Behavioural tests for Cat 16 — Decision Intelligence.

These tests exercise the five real services
(:class:`DecisionPathReconstructor`, :class:`ReasoningTraceExplainer`,
:class:`DecisionAlternatives`, :class:`DecisionScorer`,
:class:`AgentTrajectoryAnalyzer`) and the five routes that expose
them, plus the closed-loop hooks that the
:class:`DecisionScorer` fires on degradation.

The tests follow two patterns:

* **Service-level unit tests** — call the service classes
  directly with mocked Postgres / telemetry collector / judge
  registry. The :func:`patch_postgres` autouse fixture in
  :mod:`tests.conftest` returns an empty ``fetch()`` by default,
  which gives the services a clean "not_found" path. Tests that
  need events override the mock with a side-effect.

* **Route-level smoke tests** — a minimal :class:`FastAPI` app
  with the ``intelligence_replay`` router mounted and
  ``get_current_user`` overridden, mirroring the pattern in
  :mod:`tests.intelligence.test_intelligence_gap_stubs`. We hit
  each of the 5 Cat 16 routes and assert the response shape.
"""

from __future__ import annotations

import importlib
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Sample data ────────────────────────────────────────────────────


def _llm_event(
    *,
    span_id: str = "s1",
    parent_span_id: str | None = None,
    timestamp: str = "2026-06-10T00:00:00+00:00",
    event_type: str = "openai.chat",
    reasoning: str = "I should look up the user first.",
    chosen_tool: str | None = "search",
    payload_extra: dict[str, Any] | None = None,
    duration_ms: float = 250.0,
    outcome: str | None = "success",
    tool_calls_full: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "reasoning": reasoning,
        "goal": "find user info",
    }
    if chosen_tool is not None:
        payload["tool_call"] = {"name": chosen_tool, "args": {"q": "x"}}
    if payload_extra:
        payload.update(payload_extra)
    ev: dict[str, Any] = {
        "event_id": f"e-{span_id}",
        "trace_id": "trace-1",
        "span_id": span_id,
        "parent_span_id": parent_span_id,
        "event_type": event_type,
        "timestamp": timestamp,
        "tenant_id": "org_test",
        "name": event_type,
        "duration_ms": duration_ms,
        "outcome": outcome,
        "payload": payload,
        "attributes": {},
        "tags": [],
        "source_format": "openai",
        "error": None,
        "agent_id": "agent-a",
        "request_body": None,
        "response_body": None,
        "reasoning": None,
        "tool_calls_full": tool_calls_full or [],
        "tool_results": [],
    }
    return ev


def _tool_result_event(
    *, span_id: str = "s2", parent_span_id: str = "s1"
) -> dict[str, Any]:
    ev = _llm_event(
        span_id=span_id,
        parent_span_id=parent_span_id,
        event_type="tool.result",
        reasoning="",
        chosen_tool=None,
        payload_extra={"result": "user 42 found"},
    )
    return ev


def _sample_tree_events() -> list[dict[str, Any]]:
    """A 3-step trajectory: LLM call → tool result → LLM call."""
    return [
        _llm_event(span_id="s1", timestamp="2026-06-10T00:00:00+00:00"),
        _tool_result_event(span_id="s2", parent_span_id="s1"),
        _llm_event(
            span_id="s3",
            parent_span_id="s1",
            timestamp="2026-06-10T00:00:01+00:00",
            chosen_tool="calculator",
            reasoning="Now compute.",
        ),
    ]


def _sample_tree() -> dict[str, Any]:
    """Build a normalised TraceTree-shaped dict the services consume."""
    events = _sample_tree_events()
    span_map: dict[str, dict[str, Any]] = {}
    for ev in events:
        span_map[ev["span_id"]] = {
            **ev,
            "children": [],
        }
    # Hook up children
    span_map["s1"]["children"].append(span_map["s2"])
    span_map["s1"]["children"].append(span_map["s3"])
    return {
        "trace_id": "trace-1",
        "tenant_id": "org_test",
        "realm": "production",
        "outcome": "success",
        "root_spans": [span_map["s1"]],
        "span_map": span_map,
        "total_duration_ms": 500.0,
        "span_count": 3,
    }


# ─── Fixtures ───────────────────────────────────────────────────────


@pytest.fixture
def mock_pg_with_events(mock_postgres_client: MagicMock) -> MagicMock:
    """Override the autouse empty fetch() with a side-effect that
    returns the sample events for the Cat 16 query."""
    events = _sample_tree_events()
    mock_postgres_client.fetch = AsyncMock(return_value=events)
    return mock_postgres_client


@pytest.fixture
def mock_collector() -> MagicMock:
    """Mock the TelemetryCollector for the path reconstructor."""
    collector = MagicMock()
    tree = _sample_tree()
    collector.get_trace_tree = AsyncMock(return_value=tree)
    return collector


# ─── 1. DecisionPathReconstructor ──────────────────────────────────


class TestDecisionPathReconstructor:
    @pytest.mark.asyncio
    async def test_missing_trace_returns_not_found(
        self, mock_postgres_client: MagicMock
    ) -> None:
        # The autouse fixture returns [] for fetch() and None for
        # get_trace_tree. The path reconstructor uses the
        # collector, which returns None for a missing trace.
        from eden.decision import DecisionPathReconstructor

        with patch(
            "eden.observability.telemetry_collector.get_telemetry_collector",
            new=AsyncMock(return_value=None),
        ):
            result = await DecisionPathReconstructor().reconstruct(
                "org_test", "trace-missing"
            )
        assert result["status"] == "not_found"
        assert result["feature"] == "decision_path"
        assert result["data"]["trace_id"] == "trace-missing"

    @pytest.mark.asyncio
    async def test_multi_step_extracts_three_steps(
        self, mock_collector: MagicMock
    ) -> None:
        from eden.decision import DecisionPathReconstructor

        with patch(
            "eden.observability.telemetry_collector.get_telemetry_collector",
            new=AsyncMock(return_value=mock_collector),
        ), patch(
            "eden.decision.path_reconstructor._delete_then_insert",
            new=AsyncMock(),
        ) as persist:
            result = await DecisionPathReconstructor().reconstruct(
                "org_test", "trace-1"
            )
        assert result["status"] == "ok"
        assert result["feature"] == "decision_path"
        assert result["live"] is True
        assert result["data"]["step_count"] == 3
        steps = result["data"]["steps"]
        # 2 LLM + 1 tool_result
        assert {s["event_type"] for s in steps} == {"llm_call", "tool_result"}
        # The chosen action is the tool name for the LLM events
        llm_steps = [s for s in steps if s["event_type"] == "llm_call"]
        assert {s["chosen_action"] for s in llm_steps} == {
            "search",
            "calculator",
        }
        # Reasoning propagated
        assert any("look up" in (s["reasoning"] or "") for s in steps)
        # Persistence called once (for the path_json row)
        persist.assert_awaited_once()
        args, _ = persist.await_args
        assert args[1] == "trace-1"
        assert args[2] == "decision_paths"


# ─── 2. ReasoningTraceExplainer ────────────────────────────────────


class TestReasoningTraceExplainer:
    @pytest.mark.asyncio
    async def test_missing_trace_returns_not_found(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.decision import ReasoningTraceExplainer

        result = await ReasoningTraceExplainer().explain(
            "org_test", "trace-missing"
        )
        assert result["status"] == "not_found"

    @pytest.mark.asyncio
    async def test_extracts_reasoning_per_llm_event(
        self, mock_pg_with_events: MagicMock
    ) -> None:
        from eden.decision import ReasoningTraceExplainer

        result = await ReasoningTraceExplainer().explain(
            "org_test", "trace-1"
        )
        assert result["status"] == "ok"
        steps = result["data"]["steps"]
        # Only LLM events become explainer steps
        assert all(s["event_type"] == "llm_call" for s in steps)
        assert len(steps) == 2
        # Each step has reasoning text
        assert all(s["reasoning_text"] for s in steps)
        # The second LLM event (s3) is preceded by the tool.result
        # (s2) in timestamp order, so its observation is
        # populated. The first LLM event (s1) has no preceding
        # tool.result and an empty observation.
        assert steps[0]["observation"] == ""
        assert steps[1]["observation"] == "user 42 found"
        assert steps[1]["observation_span_id"] == "s2"


# ─── 3. DecisionAlternatives ───────────────────────────────────────


class TestDecisionAlternatives:
    @pytest.mark.asyncio
    async def test_missing_trace_returns_not_found(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.decision import DecisionAlternatives

        result = await DecisionAlternatives().list_considered(
            "org_test", "trace-missing"
        )
        assert result["status"] == "not_found"

    @pytest.mark.asyncio
    async def test_empty_fallback_includes_chosen_with_notes(
        self, mock_pg_with_events: MagicMock
    ) -> None:
        from eden.decision import DecisionAlternatives

        with patch(
            "eden.decision.alternatives._delete_then_insert", new=AsyncMock()
        ) as delete, patch(
            "eden.decision.alternatives._insert_rows", new=AsyncMock()
        ) as insert:
            result = await DecisionAlternatives().list_considered(
                "org_test", "trace-1"
            )
        assert result["status"] == "ok"
        steps = result["data"]["steps"]
        # The sample events have no ``considered_alternatives``
        # in the payload, so the notes field is populated.
        assert all("notes" in s for s in steps)
        # The chosen tool is always present in the considered set
        for s in steps:
            assert s["chosen"] in s["considered"]
        # The delete+insert pattern ran once each
        delete.assert_awaited()
        insert.assert_awaited()

    @pytest.mark.asyncio
    async def test_extracts_explicit_alternatives(
        self, mock_pg_with_events: MagicMock
    ) -> None:
        # Add a considered_alternatives field to the first LLM
        # event and re-run.
        events = mock_pg_with_events.fetch.return_value
        events[0]["payload"]["considered_alternatives"] = ["search", "lookup"]
        events[0]["payload"]["tool_call"]["name"] = "search"

        from eden.decision import DecisionAlternatives

        with patch(
            "eden.decision.alternatives._delete_then_insert", new=AsyncMock()
        ), patch(
            "eden.decision.alternatives._insert_rows", new=AsyncMock()
        ):
            result = await DecisionAlternatives().list_considered(
                "org_test", "trace-1"
            )
        first_step = result["data"]["steps"][0]
        assert "search" in first_step["considered"]
        assert "lookup" in first_step["considered"]
        assert first_step["chosen"] == "search"
        assert "notes" not in first_step or first_step.get("notes") is None


# ─── 4. AgentTrajectoryAnalyzer ────────────────────────────────────


class TestAgentTrajectoryAnalyzer:
    @pytest.mark.asyncio
    async def test_missing_trace_returns_not_found(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.decision import AgentTrajectoryAnalyzer

        result = await AgentTrajectoryAnalyzer().analyze(
            "org_test", "trace-missing"
        )
        assert result["status"] == "not_found"

    @pytest.mark.asyncio
    async def test_aggregates_counts_and_persists(
        self, mock_pg_with_events: MagicMock
    ) -> None:
        from eden.decision import AgentTrajectoryAnalyzer

        with patch(
            "eden.decision.trajectory_analyzer._delete_then_insert",
            new=AsyncMock(),
        ) as persist:
            result = await AgentTrajectoryAnalyzer().analyze(
                "org_test", "trace-1"
            )
        assert result["status"] == "ok"
        analysis = result["data"]["analysis"]
        trajectory = result["data"]["trajectory"]

        assert analysis["total_steps"] == 3
        assert analysis["llm_call_count"] == 2
        assert analysis["tool_call_count"] == 0  # tool.result isn't a tool_call
        assert analysis["tool_result_count"] == 1
        assert analysis["span_count"] == 0
        assert analysis["error_count"] == 0
        assert analysis["outcome"] == "success"
        assert len(trajectory) == 3
        # Persisted to agent_trajectories
        persist.assert_awaited_once()
        args, _ = persist.await_args
        assert args[1] == "trace-1"
        assert args[2] == "agent_trajectories"

    @pytest.mark.asyncio
    async def test_flags_repeated_tools(
        self, mock_postgres_client: MagicMock
    ) -> None:
        # 4 calls to the same tool => coherence issue
        events = [
            _llm_event(span_id=f"s{i}", chosen_tool="search", reasoning="x")
            for i in range(4)
        ]
        mock_postgres_client.fetch = AsyncMock(return_value=events)

        from eden.decision import AgentTrajectoryAnalyzer

        with patch(
            "eden.decision.trajectory_analyzer._delete_then_insert",
            new=AsyncMock(),
        ):
            result = await AgentTrajectoryAnalyzer().analyze(
                "org_test", "trace-1"
            )
        issues = result["data"]["analysis"]["coherence_issues"]
        kinds = {i["kind"] for i in issues}
        assert "repeated_tool" in kinds
        # No reasoning was recorded on the events above
        # (the helper sets reasoning="x" but the _is_llm_event
        # check in _step_kind uses payload.reasoning which
        # _llm_event populates too, so reasoning_recorded is > 0).
        assert "no_reasoning_recorded" not in kinds


# ─── 5. DecisionScorer ─────────────────────────────────────────────


def _fake_judge(name: str, score_value: float, rationale: str = "ok"):
    """Build a mock Judge whose .matches() returns True and
    whose .score() returns a stub JudgeScore."""
    from eden.llmops.judges.base import JudgeScore

    judge = MagicMock()
    judge.name = name
    judge.version = "2026-06-10"
    judge.model_slot = "fast"
    judge.matches = MagicMock(return_value=True)
    judge.score = AsyncMock(
        return_value=JudgeScore(
            judge_name=name,
            judge_version="2026-06-10",
            trace_id="trace-1",
            span_id=None,
            score=score_value,
            rationale=rationale,
            model="test-model",
            latency_ms=1.0,
        )
    )
    return judge


def _patched_scorer_dependencies(
    *,
    events: list[dict[str, Any]],
    ac_score: float,
    ts_score: float,
    rc_score: float,
    hook_guards=None,
):
    """Return a context manager stack that wires the scorer's
    external dependencies to mocks."""
    from contextlib import ExitStack

    stack = ExitStack()
    # Postgres
    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=events)
    stack.enter_context(
        patch("eden.storage.postgres.get_postgres_client", return_value=pg)
    )
    # Judge registry
    ac_judge = _fake_judge("action_completion", ac_score, "ac rationale")
    ts_judge = _fake_judge("tool_selection_quality", ts_score, "ts rationale")
    rc_judge = _fake_judge("reasoning_coherence", rc_score, "rc rationale")
    registry = MagicMock()
    registry.get = MagicMock(
        side_effect=lambda name: {
            "action_completion": ac_judge,
            "tool_selection_quality": ts_judge,
            "reasoning_coherence": rc_judge,
        }.get(name)
    )
    stack.enter_context(
        patch(
            "eden.llmops.judges.registry.get_judge_registry",
            return_value=registry,
        )
    )
    # LLM client — None so the judges return low-confidence.
    # We bypass the judges' own logic by returning the
    # JudgeScore directly from the mock above.
    stack.enter_context(
        patch(
            "eden.llm.client.OpenRouterClient",
            side_effect=Exception("no key in test"),
        )
    )
    # Hooks
    guard_mock = MagicMock()
    promo_mock = MagicMock()
    if hook_guards is not None:
        hook_guards["guardrail"] = guard_mock
        hook_guards["promotion"] = promo_mock
    stack.enter_context(
        patch(
            "eden.llmops.promotion_hooks.get_guardrail_hook",
            return_value=guard_mock,
        )
    )
    stack.enter_context(
        patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=promo_mock,
        )
    )
    return stack


class TestDecisionScorer:
    @pytest.mark.asyncio
    async def test_missing_trace_returns_not_found(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.decision import DecisionScorer

        result = await DecisionScorer().score("org_test", "trace-missing")
        assert result["status"] == "not_found"

    @pytest.mark.asyncio
    async def test_aggregates_weighted_components(self) -> None:
        from eden.decision import DecisionScorer

        events = _sample_tree_events()
        # Force the scorer to evaluate exactly 1 event so the
        # math is deterministic.
        events = events[:1]
        hooks: dict[str, MagicMock] = {}
        with _patched_scorer_dependencies(
            events=events,
            ac_score=0.8,
            ts_score=0.6,
            rc_score=0.7,
            hook_guards=hooks,
        ), patch(
            "eden.decision.decision_scorer._delete_then_insert",
            new=AsyncMock(),
        ):
            result = await DecisionScorer().score("org_test", "trace-1")
        assert result["status"] == "ok"
        comps = result["data"]["components"]
        assert comps["action_completion"] == pytest.approx(0.8)
        assert comps["tool_selection_quality"] == pytest.approx(0.6)
        assert comps["reasoning_coherence"] == pytest.approx(0.7)
        # Weighted: 0.4*0.8 + 0.3*0.6 + 0.3*0.7 = 0.32+0.18+0.21 = 0.71
        assert result["data"]["overall_score"] == pytest.approx(0.71, rel=1e-3)
        assert result["data"]["verdict"] == "ok"
        # No low-score judges => no hook fires
        hooks["guardrail"].on_judge_below_floor.assert_not_called()
        hooks["promotion"].on_judge_regression.assert_not_called()

    @pytest.mark.asyncio
    async def test_fires_low_score_hook(self) -> None:
        from eden.decision import DecisionScorer

        events = _sample_tree_events()[:1]
        hooks: dict[str, MagicMock] = {}
        with _patched_scorer_dependencies(
            events=events,
            ac_score=0.1,  # below LOW_SCORE_THRESHOLD (0.3)
            ts_score=0.6,
            rc_score=0.7,
            hook_guards=hooks,
        ):
            with patch(
                "eden.decision.decision_scorer._delete_then_insert",
                new=AsyncMock(),
            ):
                result = await DecisionScorer().score("org_test", "trace-1")
        # The action_completion judge fell below the floor
        assert "action_completion" in result["data"]["low_scores"]
        # The guardrail hook was called for that judge
        hooks["guardrail"].on_judge_below_floor.assert_called_once()
        args, kwargs = hooks["guardrail"].on_judge_below_floor.call_args
        assert args[0] == "org_test"
        assert kwargs.get("judge_name") == "action_completion"

    @pytest.mark.asyncio
    async def test_fires_regression_hook_when_overall_low(self) -> None:
        from eden.decision import DecisionScorer

        events = _sample_tree_events()[:1]
        hooks: dict[str, MagicMock] = {}
        with _patched_scorer_dependencies(
            events=events,
            ac_score=0.1,
            ts_score=0.5,
            rc_score=0.5,
            hook_guards=hooks,
        ), patch(
            "eden.decision.decision_scorer._delete_then_insert",
            new=AsyncMock(),
        ):
            result = await DecisionScorer().score("org_test", "trace-1")
        # Weighted: 0.4*0.1 + 0.3*0.5 + 0.3*0.5 = 0.04+0.15+0.15 = 0.34
        # which is below OVERALL_LOW_THRESHOLD (0.4)
        assert result["data"]["verdict"] == "degraded"
        assert result["data"]["overall_score"] < 0.4
        # Both hooks fired
        hooks["guardrail"].on_judge_below_floor.assert_called_once()
        hooks["promotion"].on_judge_regression.assert_called_once()
        promo_args, promo_kwargs = hooks[
            "promotion"
        ].on_judge_regression.call_args
        assert promo_args[0] == "org_test"
        assert promo_kwargs.get("judge_name") == "decision_scorer_overall"
        assert promo_kwargs.get("trace_id") == "trace-1"

    @pytest.mark.asyncio
    async def test_handles_missing_judges(self) -> None:
        from eden.decision import DecisionScorer

        events = _sample_tree_events()
        # No judges registered at all
        empty_registry = MagicMock()
        empty_registry.get = MagicMock(return_value=None)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            return_value=MagicMock(
                fetch=AsyncMock(return_value=events)
            ),
        ), patch(
            "eden.llmops.judges.registry.get_judge_registry",
            return_value=empty_registry,
        ), patch(
            "eden.decision.decision_scorer._delete_then_insert",
            new=AsyncMock(),
        ) as persist:
            result = await DecisionScorer().score(
                "org_test", "trace-1"
            )
        assert result["status"] == "ok"
        assert result["data"]["verdict"] == "no_judges"
        assert result["data"]["overall_score"] is None
        # Persistence still happened with score=None
        persist.assert_awaited_once()


# ─── 6. Route wiring smoke tests ───────────────────────────────────


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


@pytest.fixture(scope="module")
def decision_app() -> FastAPI:
    from eden.api.deps import get_current_user, require_org_member, require_path_org_access
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    app = FastAPI(title="eden-decision-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
    app.dependency_overrides[require_path_org_access] = lambda: "org_x"
    mod = importlib.import_module("eden.api.routes.intelligence_replay")
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def decision_client(decision_app: FastAPI) -> TestClient:
    return TestClient(decision_app)


@pytest.mark.parametrize(
    "path",
    [
        "/orgs/org_x/intelligence/replay/trace-1/decision/path",
        "/orgs/org_x/intelligence/replay/trace-1/decision/explain",
        "/orgs/org_x/intelligence/replay/trace-1/decision/alternatives",
        "/orgs/org_x/intelligence/replay/trace-1/decision/score",
        "/orgs/org_x/intelligence/replay/trace-1/decision/trajectory",
    ],
)
def test_decision_routes_return_envelope(
    decision_client: TestClient, path: str
) -> None:
    """Every Cat 16 route returns the uniform envelope (status,
    feature, live fields present) — even when the underlying
    service can't find the trace in the test's empty DB."""
    if path.endswith("/score") or path.endswith("/path") or path.endswith("/explain"):
        resp = decision_client.post(path)
    else:
        resp = decision_client.get(path)
    # 200 (live ok) or 200 with not_found are both fine; the
    # existing test_envelope_shape test in
    # test_intelligence_gap_stubs asserts 200/501; we extend that
    # to also accept the not_found shape.
    assert resp.status_code == 200, (
        f"unexpected status {resp.status_code} for {path}: {resp.text}"
    )
    data = resp.json()
    assert "status" in data
    assert "feature" in data
    assert "live" in data
    assert data["feature"].startswith("decision_") or data["feature"] in {
        "decision_path",
        "reasoning_explainer",
        "decision_alternatives",
        "decision_scorer",
        "agent_trajectory",
    }


# ─── 7. Package contract: lazy re-exports ───────────────────────────


class TestPackageContract:
    """The package uses PEP 562 ``__getattr__`` so the public
    surface is importable without pulling every service module
    (and its transitive deps) into ``sys.modules`` at import
    time. These tests lock in that contract."""

    def test_lazy_re_exports_resolve(self) -> None:
        import eden.decision

        for name in (
            "AgentTrajectoryAnalyzer",
            "DecisionAlternatives",
            "DecisionPathReconstructor",
            "DecisionScorer",
            "ReasoningTraceExplainer",
        ):
            value = getattr(eden.decision, name)
            assert value is not None
            # Each re-export is the actual class, not a wrapper.
            assert isinstance(value, type)

    def test_unknown_attribute_raises(self) -> None:
        import eden.decision

        with pytest.raises(AttributeError):
            _ = eden.decision.NotARealService  # type: ignore[attr-defined]

    def test_dir_lists_public_names(self) -> None:
        import eden.decision

        public = dir(eden.decision)
        for name in (
            "AgentTrajectoryAnalyzer",
            "DecisionAlternatives",
            "DecisionPathReconstructor",
            "DecisionScorer",
            "ReasoningTraceExplainer",
        ):
            assert name in public

    def test_resolved_class_is_cached(self) -> None:
        """A second ``getattr`` returns the exact same object —
        i.e. the lazy resolver caches the import in the module
        globals after the first access."""
        import eden.decision

        first = eden.decision.DecisionPathReconstructor
        second = eden.decision.DecisionPathReconstructor
        assert first is second

    def test_cold_import_does_not_load_scorer(self) -> None:
        """``eden.decision.decision_scorer`` should NOT be in
        ``sys.modules`` until something resolves ``DecisionScorer``
        (or another service that imports it). The router's lazy
        per-route imports rely on this — if the cold path
        pulled the scorer in, every replay request would
        import the LLM client at startup."""
        # Drop everything that might have been cached by
        # earlier tests in this session.
        for mod in list(sys.modules):
            if mod == "eden.decision" or mod.startswith("eden.decision."):
                del sys.modules[mod]
        # Now do a single cold import and check.
        from eden.decision import DecisionPathReconstructor  # noqa: F401

        assert "eden.decision.decision_scorer" not in sys.modules


# ─── 8. Light event builder ────────────────────────────────────────


class TestLightEventBuilder:
    """The decision scorer uses the ``_LightEvent`` slot-based
    shim so the 3 Galileo judges can read the few fields they
    need without reconstructing the full ``TelemetryEvent``
    dataclass. Verify the shim is populated correctly."""

    def test_populates_known_slots(self) -> None:
        from eden.decision._common import _build_light_event

        row = {
            "event_id": "e1",
            "trace_id": "t1",
            "span_id": "s1",
            "event_type": "openai.chat",
            "payload": {"reasoning": "thinking..."},
            "attributes": {"model": "gpt-4"},
            "tags": ["prod"],
            "source_format": "openai",
        }
        ev = _build_light_event(row, tenant_id="org_test")
        assert ev.event_id == "e1"
        assert ev.trace_id == "t1"
        assert ev.span_id == "s1"
        assert ev.event_type == "openai.chat"
        assert ev.payload == {"reasoning": "thinking..."}
        assert ev.attributes == {"model": "gpt-4"}
        assert ev.tags == ["prod"]
        assert ev.source_format == "openai"
        assert ev.tenant_id == "org_test"

    def test_missing_keys_default_to_none(self) -> None:
        from eden.decision._common import _build_light_event

        ev = _build_light_event({}, tenant_id="org_test")
        assert ev.event_id is None
        assert ev.payload is None
        assert ev.attributes is None
        assert ev.tags is None
        assert ev.tenant_id == "org_test"


# ─── 9. Envelope helpers ────────────────────────────────────────────


class TestEnvelopeHelpers:
    def test_ok_envelope_shape(self) -> None:
        from eden.decision._common import _ok_envelope

        data = _ok_envelope("decision_path", {"step_count": 3})
        assert data["status"] == "ok"
        assert data["feature"] == "decision_path"
        assert data["live"] is True
        assert "trace_id" in data
        assert "timestamp" in data
        assert data["data"] == {"step_count": 3}

    def test_not_found_envelope_shape(self) -> None:
        from eden.decision._common import _not_found_envelope

        data = _not_found_envelope("decision_scorer", "trace-missing")
        assert data["status"] == "not_found"
        assert data["feature"] == "decision_scorer"
        assert data["live"] is True
        assert data["data"]["trace_id"] == "trace-missing"
        assert "reason" in data["data"]


# ─── 10. End-to-end persistence integration ─────────────────────────


class TestPersistenceIntegration:
    """Verify that the service classes pass the right arguments
    to the persistence helpers — table name, org_id, trace_id,
    columns, values. These tests don't hit a real DB; they
    assert on the call args of the mocked persistence helper so
    a real implementation has only to wire up the right SQL."""

    @pytest.mark.asyncio
    async def test_path_reconstructor_passes_correct_args(
        self, mock_collector: MagicMock
    ) -> None:
        from eden.decision import DecisionPathReconstructor

        with patch(
            "eden.observability.telemetry_collector.get_telemetry_collector",
            new=AsyncMock(return_value=mock_collector),
        ), patch(
            "eden.decision.path_reconstructor._delete_then_insert",
            new=AsyncMock(),
        ) as persist:
            await DecisionPathReconstructor().reconstruct(
                "org_test", "trace-1"
            )
        # 4 positional args: org_id, trace_id, table, columns, values
        call_args = persist.await_args
        args, kwargs = call_args
        # org_id is a kwarg-style or positional; either way, the
        # 4th positional is the table name.
        assert args[0] == "org_test"
        assert args[1] == "trace-1"
        assert args[2] == "decision_paths"
        # 4th positional is the columns list
        assert set(args[3]) == {
            "step_index",
            "reasoning",
            "chosen_action",
            "path_json",
        }
        # 5th positional is the values list (step_index=0 for the
        # first step, then the persisted fields, then a JSON
        # blob of the full step list).
        assert args[4][0] == 0  # step_index
        path_json = args[4][3]
        # The JSON should parse to {"steps": [...]} — the full
        # step list is stored in the first row's path_json.
        import json

        decoded = json.loads(path_json)
        assert "steps" in decoded
        assert isinstance(decoded["steps"], list)

    @pytest.mark.asyncio
    async def test_alternatives_passes_correct_args(
        self, mock_pg_with_events: MagicMock
    ) -> None:
        from eden.decision import DecisionAlternatives

        with patch(
            "eden.decision.alternatives._delete_then_insert", new=AsyncMock()
        ), patch(
            "eden.decision.alternatives._insert_rows", new=AsyncMock()
        ) as insert:
            await DecisionAlternatives().list_considered(
                "org_test", "trace-1"
            )
        # 4 positional args: org_id, table, rows, columns
        call_args = insert.await_args
        args, kwargs = call_args
        assert args[0] == "org_test"
        assert args[1] == "decision_alternatives"
        assert set(args[3]) == {
            "step_index",
            "considered",
            "chosen",
            "score",
        }
        # Each row is a 4-tuple matching the columns
        for row in args[2]:
            assert len(row) == 4
            assert isinstance(row[1], str)  # considered (text)

    @pytest.mark.asyncio
    async def test_trajectory_persists_both_jsons(
        self, mock_pg_with_events: MagicMock
    ) -> None:
        from eden.decision import AgentTrajectoryAnalyzer

        with patch(
            "eden.decision.trajectory_analyzer._delete_then_insert",
            new=AsyncMock(),
        ) as persist:
            await AgentTrajectoryAnalyzer().analyze("org_test", "trace-1")
        # _delete_then_insert(org_id, trace_id, table, columns, values)
        args, _ = persist.await_args
        assert args[0] == "org_test"
        assert args[1] == "trace-1"
        assert args[2] == "agent_trajectories"
        columns = args[3]
        values = args[4]
        # columns is ["trajectory_json", "analysis_json"]
        assert set(columns) == {"trajectory_json", "analysis_json"}
        # values is the JSON string for each column, in order
        traj_idx = columns.index("trajectory_json")
        ana_idx = columns.index("analysis_json")
        import json

        traj = json.loads(values[traj_idx])
        ana = json.loads(values[ana_idx])
        assert "trajectory" in traj
        assert "total_steps" in ana
        assert "coherence_issues" in ana

    @pytest.mark.asyncio
    async def test_scorer_persists_one_row_per_trace(self) -> None:
        from eden.decision import DecisionScorer

        events = _sample_tree_events()[:1]
        with _patched_scorer_dependencies(
            events=events,
            ac_score=0.8,
            ts_score=0.7,
            rc_score=0.9,
        ), patch(
            "eden.decision.decision_scorer._delete_then_insert",
            new=AsyncMock(),
        ) as persist:
            await DecisionScorer().score("org_test", "trace-1")
        args, _ = persist.await_args
        assert args[0] == "org_test"
        assert args[1] == "trace-1"
        assert args[2] == "decision_scores"
        columns = args[3]
        values = args[4]
        # columns = ["score", "components_json"]
        assert set(columns) == {"score", "components_json"}
        score_idx = columns.index("score")
        comps_idx = columns.index("components_json")
        overall = values[score_idx]
        components_json = values[comps_idx]
        # Overall should be the weighted average
        assert isinstance(overall, float)
        assert 0.7 <= overall <= 0.85
        # Components JSON should have the per-judge scores and sample count
        import json

        comps = json.loads(components_json)
        assert "components" in comps
        assert "sample_count" in comps
        assert comps["components"]["action_completion"] == 0.8
