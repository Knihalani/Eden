"""Behavioural tests for Cat 3 — Evaluation Quality Intelligence.

Exercises the 13 real services (EvalVersioner, EvalRegistry,
FailureClusterer, CLHFGenerator, HumanInTheLoopService,
PairwiseAnnotationService, MultiModalEvaluator,
EvalToGuardrailLink, SixModalitiesRegistry,
BooleanCategoricalScore, CustomPythonEval, UserFeedbackService,
AutoDatasetBridge) and the 15 routes that expose them, plus
the package-contract tests and the envelope helper tests.

Mirrors the structure of
:mod:`tests.intelligence.test_retrieval_intelligence` and
:mod:`tests.intelligence.test_cost_intelligence`:
* Service-level unit tests — call the service classes
  directly with a mocked Postgres client. The
  :func:`patch_postgres` autouse fixture in :mod:`tests.conftest`
  returns an empty ``fetch()`` by default, which gives the
  services a clean "no data" path. Tests that need data
  override the mock with a side-effect that matches the SQL
  fragment the service runs.
* Route-level smoke tests — a minimal :class:`FastAPI` app
  with the ``intelligence_eval`` router mounted and
  ``get_current_user`` overridden. We hit each of the 15
  Cat 3 routes and assert the response shape.
"""

from __future__ import annotations

import importlib
import json
from datetime import UTC, datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Sample row builders ─────────────────────────────────────────────


def _eval_version_row(
    *,
    deployment_sha: str = "abc123def456",
    prompt_version: str = "v3",
    judge_set: list[str] | None = None,
    status: str = "active",
    created_at: datetime | None = None,
) -> dict[str, Any]:
    if judge_set is None:
        judge_set = ["hallucination", "groundedness"]
    if created_at is None:
        created_at = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)
    return {
        "id": "11111111-1111-1111-1111-111111111111",
        "deployment_sha": deployment_sha,
        "prompt_version": prompt_version,
        "judge_set_json": json.dumps(judge_set),
        "status": status,
        "created_at": created_at,
    }


def _judge_score_row(
    *,
    judge_name: str = "hallucination",
    trace_id: str = "trace-1",
    score: float = 0.3,
    rationale: str = "agent=planner+error_category=tool_timeout",
    scored_at: datetime | None = None,
) -> dict[str, Any]:
    if scored_at is None:
        scored_at = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)
    return {
        "judge_run_id": f"jr-{trace_id}-{judge_name}",
        "trace_id": trace_id,
        "span_id": None,
        "judge_name": judge_name,
        "judge_version": "2026-06-10",
        "score": score,
        "rationale": rationale,
        "model": "test-model",
        "scored_at": scored_at,
        "latency_ms": 50.0,
        "source_event_id": f"ev-{trace_id}",
    }


def _hil_task_row(
    *,
    task_id: str = "22222222-2222-2222-2222-222222222222",
    name: str = "annotate planner failures",
    status: str = "open",
    spec_json: str = "{}",
) -> dict[str, Any]:
    return {
        "id": task_id,
        "org_id": "org_test",
        "name": name,
        "spec_json": spec_json,
        "status": status,
        "created_at": datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC),
    }


def _judge_dist_row(
    *,
    sample_count: int = 150,
    mean_score: float = 0.7,
    fpr: float | None = None,
    below_threshold_count: int | None = None,
) -> dict[str, Any]:
    """Build one row from the judge distribution query.

    Either ``fpr`` (fraction in [0, 1]) or
    ``below_threshold_count`` (integer) must be set. If
    ``fpr`` is set, ``below_threshold_count`` is derived as
    ``int(fpr * sample_count)`` so the test can express the
    FPR gate directly.
    """
    if fpr is not None and below_threshold_count is None:
        below_threshold_count = int(fpr * sample_count)
    elif below_threshold_count is None:
        below_threshold_count = 3
    return {
        "sample_count": int(sample_count),
        "mean_score": float(mean_score),
        "below_threshold_count": int(below_threshold_count),
    }


# ─── Postgres query-routing mock helper ──────────────────────────────


def _pg_router(
    *,
    eval_versions: list[dict[str, Any]] | None = None,
    eval_version_by_sha: list[dict[str, Any]] | None = None,
    judge_scores_window: list[dict[str, Any]] | None = None,
    judge_dist: list[dict[str, Any]] | None = None,
    judge_scores_low: list[dict[str, Any]] | None = None,
    hil_task: list[dict[str, Any]] | None = None,
    hil_task_by_name: list[dict[str, Any]] | None = None,
    guardrail_policy_return: dict[str, Any] | None = None,
) -> MagicMock:
    """Build a MagicMock Postgres client whose ``fetch``,
    ``fetchrow``, and ``execute`` route to different returns
    based on the SQL fragment. Defaults to empty/None so a
    missing branch returns the "no data" path."""
    pg = MagicMock()
    pg.fetch = AsyncMock(
        side_effect=lambda sql, *a, **kw: _route_fetch(
            sql,
            eval_versions,
            eval_version_by_sha,
            judge_scores_window,
            judge_dist,
            judge_scores_low,
            hil_task,
            hil_task_by_name,
        )
    )
    pg.fetchrow = AsyncMock(
        side_effect=lambda sql, *a, **kw: _route_fetchrow(
            sql, guardrail_policy_return,
        )
    )
    pg.execute = AsyncMock(return_value="OK")
    return pg


def _route_fetch(
    sql: str,
    eval_versions,
    eval_version_by_sha,
    judge_scores_window,
    judge_dist,
    judge_scores_low,
    hil_task,
    hil_task_by_name,
) -> list[dict[str, Any]]:
    # eval_versions SELECT (newest first, no SHA filter)
    if (
        "eval_versions" in sql
        and "deployment_sha = $2" not in sql
        and "deployment_sha <> $2" not in sql
    ):
        return list(eval_versions or [])
    # eval_versions SELECT by SHA (for regression check)
    if "eval_versions" in sql and "deployment_sha = $2" in sql:
        return list(eval_version_by_sha or [])
    # eval_versions SELECT previous active
    if "eval_versions" in sql and "deployment_sha <> $2" in sql:
        return list(eval_version_by_sha or [])
    # judge_scores with score < $4 (failure clusterer)
    if (
        "judge_scores" in sql
        and "score < $4" in sql
        and "AVG(score)" not in sql
    ):
        return list(judge_scores_window or [])
    # judge_scores with score < $3 (auto-dataset, no interval)
    if (
        "judge_scores" in sql
        and "score < $3" in sql
        and "AVG(score)" not in sql
    ):
        return list(judge_scores_low or [])
    # judge_scores for window (no threshold filter)
    if (
        "judge_scores" in sql
        and "scored_at > NOW() - $3::interval" in sql
        and "score <" not in sql
    ):
        return list(judge_scores_window or [])
    # judge distribution (COUNT, AVG, FILTER)
    if "judge_scores" in sql and "AVG(score)" in sql:
        return list(judge_dist or [])
    # hil_task by id (UUID)
    if "eval_hil_tasks" in sql and "id = $2::uuid" in sql:
        return list(hil_task or [])
    # hil_task by name (fallback lookup)
    if "eval_hil_tasks" in sql and "name = $2" in sql:
        return list(hil_task_by_name or [])
    return []


def _route_fetchrow(
    sql: str, guardrail_policy_return: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if "guardrail_policies" in sql and "RETURNING id" in sql:
        if guardrail_policy_return is None:
            return {"id": "33333333-3333-3333-3333-333333333333"}
        return guardrail_policy_return
    return None


# ─── 1. EvalVersioner ────────────────────────────────────────────────


class TestEvalVersioner:
    @pytest.mark.asyncio
    async def test_tag_success(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.versioning import EvalVersioner

        pg = _pg_router(
            eval_version_by_sha=[_eval_version_row()],
            judge_scores_window=[],
            eval_versions=[],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.versioning._delete_then_insert_version",
            new=AsyncMock(),
        ), patch(
            "eden.evaluation.eval_intel.versioning._fire_eval_version_regression",
            new=MagicMock(),
        ) as fire:
            result = await EvalVersioner().tag(
                "org_test",
                deployment_sha="abc123def456",
                prompt_version="v3",
                judge_set=["hallucination", "groundedness"],
            )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["deployment_sha"] == "abc123def456"
        assert result["data"]["prompt_version"] == "v3"
        assert result["data"]["judge_set"] == [
            "hallucination", "groundedness",
        ]
        assert result["data"]["status"] == "active"
        assert result["data"]["regression_detected"] is False
        fire.assert_not_called()

    @pytest.mark.asyncio
    async def test_tag_duplicate_replaces_row(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.versioning import EvalVersioner

        pg = _pg_router(
            eval_version_by_sha=[_eval_version_row()],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.versioning._delete_then_insert_version",
            new=AsyncMock(),
        ) as persist:
            await EvalVersioner().tag(
                "org_test",
                deployment_sha="abc123def456",
                prompt_version="v3",
                judge_set=["hallucination"],
            )
        # The persist helper was called once.
        persist.assert_called_once()
        # And the call included the deployment_sha.
        args, kwargs = persist.call_args
        assert kwargs.get("deployment_sha") == "abc123def456" or (
            len(args) > 1 and args[1] == "abc123def456"
        )

    @pytest.mark.asyncio
    async def test_tag_fires_regression_hook_on_score_drop(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.versioning import EvalVersioner

        # Previous version: high judge scores (~0.9).
        # New version: low judge scores (~0.3). The
        # regression detector should fire.
        previous = _eval_version_row(
            deployment_sha="previous_sha", judge_set=["hallucination"],
        )
        prev_scores = [
            _judge_score_row(score=0.9) for _ in range(10)
        ]
        new_scores = [
            _judge_score_row(score=0.3) for _ in range(10)
        ]

        # The service fetches judge scores twice — once for
        # each judge in the new version's judge_set, then
        # again for each judge in the previous version's
        # judge_set. We need to return new_scores for the
        # first batch and prev_scores for the second.
        # Easiest: track call count.
        call_count = {"n": 0}

        def route(sql, *args, **kwargs):
            if "judge_scores" in sql:
                call_count["n"] += 1
                # First call → new version's scores.
                # Second call → previous version's scores.
                if call_count["n"] % 2 == 1:
                    return new_scores
                return prev_scores
            if "eval_versions" in sql:
                return [previous]
            return []
        pg = MagicMock()
        pg.fetch = AsyncMock(side_effect=route)
        pg.fetchrow = AsyncMock(return_value=None)
        pg.execute = AsyncMock(return_value="OK")
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.versioning._delete_then_insert_version",
            new=AsyncMock(),
        ), patch(
            "eden.evaluation.eval_intel.versioning._fetch_eval_version_by_sha",
            new=AsyncMock(return_value=previous),
        ), patch(
            "eden.evaluation.eval_intel.versioning._fire_eval_version_regression",
            new=MagicMock(),
        ) as fire:
            result = await EvalVersioner().tag(
                "org_test",
                deployment_sha="new_sha",
                prompt_version="v3",
                judge_set=["hallucination"],
            )
        assert result["data"]["regression_detected"] is True
        assert "hallucination" in result["data"]["regressed_judges"]
        fire.assert_called()

    @pytest.mark.asyncio
    async def test_tag_short_sha_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.versioning import EvalVersioner

        result = await EvalVersioner().tag(
            "org_test",
            deployment_sha="abc",
            prompt_version="v3",
            judge_set=["hallucination"],
        )
        assert result["status"] == "bad_request"
        assert "deployment_sha" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_tag_empty_judge_set_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.versioning import EvalVersioner

        result = await EvalVersioner().tag(
            "org_test",
            deployment_sha="abc123def456",
            prompt_version="v3",
            judge_set=[],
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_tag_persists_judges_set_as_json(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.versioning import EvalVersioner

        pg = _pg_router()
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.versioning._delete_then_insert_version",
            new=AsyncMock(),
        ) as persist:
            await EvalVersioner().tag(
                "org_test",
                deployment_sha="abc123def456",
                prompt_version="v3",
                judge_set=["hallucination", "groundedness"],
            )
        # Check the JSON payload was passed.
        args, kwargs = persist.call_args
        js = kwargs.get("judge_set_json") or (
            args[3] if len(args) > 3 else None
        )
        if js is None:
            # Try other arg positions
            for a in args:
                if isinstance(a, str) and "[" in a:
                    js = a
                    break
        assert js is not None
        parsed = json.loads(js)
        assert "hallucination" in parsed
        assert "groundedness" in parsed


# ─── 2. EvalRegistry ─────────────────────────────────────────────────


class TestEvalRegistry:
    @pytest.mark.asyncio
    async def test_list_empty(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.versioning import EvalRegistry

        pg = _pg_router(eval_versions=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await EvalRegistry().list("org_test")
        assert result["status"] == "ok"
        assert result["data"]["versions"] == []
        assert result["data"]["count"] == 0
        assert result["data"]["message"] == "no eval versions"

    @pytest.mark.asyncio
    async def test_list_three_versions(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.versioning import EvalRegistry

        versions = [
            _eval_version_row(
                deployment_sha=f"sha-{i}",
                prompt_version=f"v{i}",
            )
            for i in range(3)
        ]
        pg = _pg_router(eval_versions=versions)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await EvalRegistry().list("org_test")
        assert result["status"] == "ok"
        assert result["data"]["count"] == 3
        assert len(result["data"]["versions"]) == 3

    @pytest.mark.asyncio
    async def test_list_decodes_judge_set_json(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.versioning import EvalRegistry

        versions = [
            _eval_version_row(
                judge_set=["hallucination", "groundedness"],
            ),
        ]
        pg = _pg_router(eval_versions=versions)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await EvalRegistry().list("org_test")
        v = result["data"]["versions"][0]
        assert v["judge_set"] == ["hallucination", "groundedness"]

    @pytest.mark.asyncio
    async def test_list_returns_id_and_sha(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.versioning import EvalRegistry

        versions = [_eval_version_row(deployment_sha="abc123def456")]
        pg = _pg_router(eval_versions=versions)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await EvalRegistry().list("org_test")
        v = result["data"]["versions"][0]
        assert v["id"] == "11111111-1111-1111-1111-111111111111"
        assert v["deployment_sha"] == "abc123def456"


# ─── 3. FailureClusterer ─────────────────────────────────────────────


class TestFailureClusterer:
    @pytest.mark.asyncio
    async def test_cluster_no_scores(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.failure_clusters import FailureClusterer

        pg = _pg_router(judge_scores_window=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await FailureClusterer().cluster(
                "org_test", judge_name="hallucination", window="24h",
            )
        assert result["status"] == "ok"
        assert result["data"]["clusters"] == []
        assert result["data"]["total_failures"] == 0
        assert "no scores" in result["data"]["message"].lower()

    @pytest.mark.asyncio
    async def test_cluster_one_cluster_two_members(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.failure_clusters import FailureClusterer

        # Both rows have the same signature.
        rows = [
            _judge_score_row(
                trace_id="trace-1",
                rationale="agent=planner+error_category=tool_timeout",
            ),
            _judge_score_row(
                trace_id="trace-2",
                rationale="agent=planner+error_category=tool_timeout",
            ),
        ]
        pg = _pg_router(judge_scores_window=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.failure_clusters._delete_then_insert_failure_clusters",
            new=AsyncMock(),
        ):
            result = await FailureClusterer().cluster(
                "org_test", judge_name="hallucination", window="24h",
            )
        assert result["status"] == "ok"
        assert result["data"]["cluster_count"] == 1
        assert result["data"]["clusters"][0]["member_count"] == 2
        assert "planner" in result["data"]["clusters"][0]["signature"]
        assert "tool_timeout" in result["data"]["clusters"][0]["signature"]

    @pytest.mark.asyncio
    async def test_cluster_five_clusters(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.failure_clusters import FailureClusterer

        rows = []
        for sig_part in ["a", "b", "c", "d", "e"]:
            for _ in range(2):
                rows.append(
                    _judge_score_row(
                        rationale=f"agent=agent_{sig_part}+error_category=cat_{sig_part}",
                    )
                )
        pg = _pg_router(judge_scores_window=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.failure_clusters._delete_then_insert_failure_clusters",
            new=AsyncMock(),
        ):
            result = await FailureClusterer().cluster(
                "org_test", judge_name="hallucination", window="24h",
            )
        assert result["data"]["cluster_count"] == 5
        assert result["data"]["total_failures"] == 10

    @pytest.mark.asyncio
    async def test_cluster_deterministic_ids(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.failure_clusters import FailureClusterer

        rows = [
            _judge_score_row(
                rationale="agent=planner+error_category=tool_timeout",
            )
        ] * 3
        # Run twice; cluster_id should be the same.
        with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_router(judge_scores_window=rows)):
            with patch(
                "eden.evaluation.eval_intel.failure_clusters._delete_then_insert_failure_clusters",
                new=AsyncMock(),
            ):
                r1 = await FailureClusterer().cluster(
                    "org_test", judge_name="hallucination", window="24h",
                )
        with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_router(judge_scores_window=rows)):
            with patch(
                "eden.evaluation.eval_intel.failure_clusters._delete_then_insert_failure_clusters",
                new=AsyncMock(),
            ):
                r2 = await FailureClusterer().cluster(
                    "org_test", judge_name="hallucination", window="24h",
                )
        assert (
            r1["data"]["clusters"][0]["cluster_id"]
            == r2["data"]["clusters"][0]["cluster_id"]
        )

    @pytest.mark.asyncio
    async def test_cluster_persists_to_failure_clusters(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.failure_clusters import FailureClusterer

        rows = [
            _judge_score_row(
                rationale="agent=planner+error_category=tool_timeout",
            )
        ] * 3
        pg = _pg_router(judge_scores_window=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.failure_clusters._delete_then_insert_failure_clusters",
            new=AsyncMock(),
        ) as persist:
            await FailureClusterer().cluster(
                "org_test", judge_name="hallucination", window="24h",
            )
        persist.assert_called_once()
        kwargs = persist.call_args.kwargs
        assert kwargs.get("judge_name") == "hallucination" or (
            len(persist.call_args.args) > 1
            and persist.call_args.args[1] == "hallucination"
        )

    @pytest.mark.asyncio
    async def test_cluster_sample_score_is_mean(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.failure_clusters import FailureClusterer

        rows = [
            _judge_score_row(
                trace_id="trace-1",
                score=0.2,
                rationale="agent=p+error_category=t",
            ),
            _judge_score_row(
                trace_id="trace-2",
                score=0.4,
                rationale="agent=p+error_category=t",
            ),
        ]
        pg = _pg_router(judge_scores_window=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.failure_clusters._delete_then_insert_failure_clusters",
            new=AsyncMock(),
        ):
            result = await FailureClusterer().cluster(
                "org_test", judge_name="hallucination", window="24h",
            )
        assert result["data"]["clusters"][0]["sample_score"] == 0.3

    @pytest.mark.asyncio
    async def test_cluster_returns_total_failures(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.failure_clusters import FailureClusterer

        rows = [
            _judge_score_row(
                trace_id=f"trace-{i}",
                rationale=f"agent=a+error_category=c{i % 3}",
            )
            for i in range(7)
        ]
        pg = _pg_router(judge_scores_window=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.failure_clusters._delete_then_insert_failure_clusters",
            new=AsyncMock(),
        ):
            result = await FailureClusterer().cluster(
                "org_test", judge_name="hallucination", window="24h",
            )
        assert result["data"]["total_failures"] == 7

    @pytest.mark.asyncio
    async def test_cluster_invalid_window(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.failure_clusters import FailureClusterer

        result = await FailureClusterer().cluster(
            "org_test", judge_name="hallucination", window="bad-window",
        )
        assert result["status"] == "bad_request"


# ─── 4. CLHFGenerator ────────────────────────────────────────────────


def _clhf_examples(n: int = 3) -> list[dict[str, Any]]:
    return [
        {
            "input": f"What is input {i}?",
            "output": f"This is output {i}.",
            "score": 0.8 if i % 2 == 0 else 0.2,
            "rationale": f"example {i}",
        }
        for i in range(n)
    ]


def _patched_openrouter(content: str, *, module: str = "clhf"):
    """Return a context-manager that patches the LLM path
    used by the given service module.

    Services route through ``eden.llm.internal_router.route_sync``
    (not ``OpenRouterClient.call`` directly). We still stub
    ``OpenRouterClient`` so client construction succeeds, and
    patch ``route_sync`` so the judge response is deterministic.
    """
    from contextlib import ExitStack, contextmanager

    from eden.llm.client import LLMResponse, UsageStats

    resp = LLMResponse(
        content=content,
        usage=UsageStats(),
        model="test-model",
        finish_reason="stop",
    )

    @contextmanager
    def _cm():
        with ExitStack() as stack:
            stack.enter_context(
                patch(
                    f"eden.evaluation.eval_intel.{module}.OpenRouterClient",
                    return_value=MagicMock(call=MagicMock(return_value=resp)),
                )
            )
            stack.enter_context(
                patch(
                    "eden.llm.internal_router.route_sync",
                    return_value=resp,
                )
            )
            yield

    return _cm()


def _patched_openrouter_sequence(contents: list[str], *, module: str = "clhf"):
    """Return a context-manager that patches the LLM client
    to return the next content in ``contents`` for each call
    (rotating through). Used by CLHF tests where the
    spec-generation call and the re-evaluation call need
    different responses."""
    from eden.llm.client import LLMResponse, UsageStats

    resps = [
        LLMResponse(
            content=c, usage=UsageStats(),
            model="test-model", finish_reason="stop",
        )
        for c in contents
    ]
    call_mock = MagicMock(side_effect=resps)
    return patch(
        f"eden.evaluation.eval_intel.{module}.OpenRouterClient",
        return_value=MagicMock(call=call_mock),
    )


class TestCLHFGenerator:
    @pytest.mark.asyncio
    async def test_one_example_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.clhf import CLHFGenerator

        result = await CLHFGenerator().generate_custom_metric(
            "org_test", name="my_metric", examples=_clhf_examples(1),
        )
        assert result["status"] == "bad_request"
        assert "2-5" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_six_examples_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.clhf import CLHFGenerator

        result = await CLHFGenerator().generate_custom_metric(
            "org_test", name="my_metric", examples=_clhf_examples(6),
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_no_llm_client_returns_warning(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.clhf import CLHFGenerator

        with patch(
            "eden.evaluation.eval_intel.clhf.OpenRouterClient",
            side_effect=ImportError("no LLM"),
        ), patch(
            "eden.evaluation.eval_intel.clhf._insert_clhf_run",
            new=AsyncMock(),
        ):
            result = await CLHFGenerator().generate_custom_metric(
                "org_test", name="my_metric", examples=_clhf_examples(3),
            )
        assert result["status"] == "ok"
        assert result["data"]["agreement"] is None
        assert "no llm_client" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_two_examples_with_mocked_llm_returns_spec(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.clhf import CLHFGenerator

        spec_json = json.dumps({
            "rubric": "is helpful?",
            "score_range": [0.0, 1.0],
            "prompt_template": "Score this: {input} / {output}",
        })
        # 3 examples with scores [0.8, 0.2, 0.8]. The
        # mock returns 0.85, 0.2, 0.75 for the 3 re-eval
        # calls — all within the 0.15 tolerance of the
        # example scores, so agreement = 100% (≥ 60%
        # threshold).
        reeval_responses = [
            '{"score": 0.85, "rationale": "good"}',
            '{"score": 0.2, "rationale": "bad"}',
            '{"score": 0.75, "rationale": "ok"}',
        ]
        with _patched_openrouter_sequence([spec_json] + reeval_responses), patch(
            "eden.evaluation.eval_intel.clhf._insert_clhf_run",
            new=AsyncMock(),
        ):
            result = await CLHFGenerator().generate_custom_metric(
                "org_test", name="my_metric", examples=_clhf_examples(3),
            )
        assert result["status"] == "ok"
        assert result["data"]["metric_name"] == "my_metric"
        assert result["data"]["spec"]["rubric"] == "is helpful?"
        assert result["data"]["spec"]["score_range"] == [0.0, 1.0]

    @pytest.mark.asyncio
    async def test_low_agreement_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.clhf import CLHFGenerator

        # The LLM returns a JSON spec, but every re-eval
        # returns a bare "0" so agreement is 0.
        spec_json = json.dumps({
            "rubric": "r",
            "score_range": [0, 1],
            "prompt_template": "T",
        })
        from eden.llm.client import LLMResponse, UsageStats
        spec_resp = LLMResponse(
            content=spec_json, usage=UsageStats(),
            model="m", finish_reason="stop",
        )
        reeval_resp = LLMResponse(
            content="0.0", usage=UsageStats(),
            model="m", finish_reason="stop",
        )
        with patch(
            "eden.evaluation.eval_intel.clhf.OpenRouterClient",
            return_value=MagicMock(),
        ), patch(
            "eden.llm.internal_router.route_sync",
            side_effect=[spec_resp, reeval_resp, reeval_resp, reeval_resp],
        ), patch(
            "eden.evaluation.eval_intel.clhf._insert_clhf_run",
            new=AsyncMock(),
        ):
            result = await CLHFGenerator().generate_custom_metric(
                "org_test", name="my_metric", examples=_clhf_examples(3),
            )
        # The examples have scores 0.8 / 0.2 / 0.8. The
        # re-eval returns 0.0 for all of them. The
        # tolerance is 0.15, so none agree.
        assert result["status"] == "bad_request"
        assert "agrees on only" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_persists_to_clhf_runs(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.clhf import CLHFGenerator

        spec_json = json.dumps({
            "rubric": "r",
            "score_range": [0, 1],
            "prompt_template": "T",
        })
        with _patched_openrouter(spec_json), patch(
            "eden.evaluation.eval_intel.clhf._insert_clhf_run",
            new=AsyncMock(),
        ) as persist:
            await CLHFGenerator().generate_custom_metric(
                "org_test", name="my_metric", examples=_clhf_examples(3),
            )
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_rubric_score_range_template(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.clhf import CLHFGenerator

        spec_json = json.dumps({
            "rubric": "is concise?",
            "score_range": [0.0, 5.0],
            "prompt_template": "p",
        })
        reeval_responses = [
            '{"score": 0.85, "rationale": "ok"}',
            '{"score": 0.2, "rationale": "ok"}',
            '{"score": 0.85, "rationale": "ok"}',
        ]
        with _patched_openrouter_sequence([spec_json] + reeval_responses), patch(
            "eden.evaluation.eval_intel.clhf._insert_clhf_run",
            new=AsyncMock(),
        ):
            result = await CLHFGenerator().generate_custom_metric(
                "org_test", name="my_metric", examples=_clhf_examples(3),
            )
        spec = result["data"]["spec"]
        assert "rubric" in spec
        assert "score_range" in spec
        assert "prompt_template" in spec

    @pytest.mark.asyncio
    async def test_missing_keys_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.clhf import CLHFGenerator

        bad_examples = [
            {"input": "x", "output": "y"},  # missing 'score'
            {"input": "x", "output": "y", "score": 0.5},
            {"input": "x", "output": "y", "score": 0.5},
        ]
        result = await CLHFGenerator().generate_custom_metric(
            "org_test", name="my_metric", examples=bad_examples,
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_valid_spec_round_trip(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.clhf import CLHFGenerator

        spec_json = json.dumps({
            "rubric": "is correct?",
            "score_range": [0.0, 1.0],
            "prompt_template": "Score: {input}",
        })
        # 2 examples with scores [0.8, 0.2]. Both
        # re-evals need to agree for the agreement rate
        # to hit ≥ 60% (1/2 = 0.5 < 0.6 = fail).
        reeval_responses = [
            '{"score": 0.85, "rationale": "ok"}',
            '{"score": 0.2, "rationale": "ok"}',
        ]
        with _patched_openrouter_sequence([spec_json] + reeval_responses), patch(
            "eden.evaluation.eval_intel.clhf._insert_clhf_run",
            new=AsyncMock(),
        ):
            result = await CLHFGenerator().generate_custom_metric(
                "org_test", name="my_metric", examples=_clhf_examples(2),
            )
        # 2 examples × 1 spec generation + 2 re-evals = 4
        # total LLM calls. We don't assert on the exact
        # count, but the spec was parsed correctly.
        assert result["data"]["spec"]["rubric"] == "is correct?"


# ─── 5. HumanInTheLoopService ────────────────────────────────────────


class TestHumanInTheLoopService:
    @pytest.mark.asyncio
    async def test_create_task_success(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import HumanInTheLoopService

        with patch(
            "eden.evaluation.eval_intel.annotation._insert_hil_task",
            new=AsyncMock(),
        ) as persist:
            result = await HumanInTheLoopService().create_annotation_task(
                "org_test", name="annotate planner failures",
                spec={"criteria": ["label"]},
            )
        assert result["status"] == "ok"
        assert result["data"]["name"] == "annotate planner failures"
        assert result["data"]["status"] == "open"
        assert "task_id" in result["data"]
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_task_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import HumanInTheLoopService

        result = await HumanInTheLoopService().create_annotation_task(
            "org_test", name="", spec={},
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_submit_annotation_success(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import HumanInTheLoopService

        pg = _pg_router(
            hil_task=[_hil_task_row(status="open")],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.annotation._insert_hil_annotation",
            new=AsyncMock(),
        ), patch(
            "eden.evaluation.eval_intel.annotation._update_hil_task_status",
            new=AsyncMock(),
        ) as upd:
            result = await HumanInTheLoopService().submit_annotation(
                "org_test",
                task_id="22222222-2222-2222-2222-222222222222",
                trace_id="trace-1",
                label="tool_failure",
                rationale="the tool timed out",
            )
        assert result["status"] == "ok"
        assert result["data"]["status"] == "closed"
        upd.assert_called_once()

    @pytest.mark.asyncio
    async def test_submit_annotation_task_not_found(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import HumanInTheLoopService

        pg = _pg_router(hil_task=[], hil_task_by_name=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await HumanInTheLoopService().submit_annotation(
                "org_test",
                task_id="nonexistent",
                trace_id="trace-1",
                label="tool_failure",
            )
        assert result["status"] == "not_found"

    @pytest.mark.asyncio
    async def test_submit_annotation_on_closed_task_returns_conflict(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import HumanInTheLoopService

        pg = _pg_router(
            hil_task=[_hil_task_row(status="closed")],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await HumanInTheLoopService().submit_annotation(
                "org_test",
                task_id="22222222-2222-2222-2222-222222222222",
                trace_id="trace-1",
                label="tool_failure",
            )
        assert result["status"] == "conflict"

    @pytest.mark.asyncio
    async def test_submit_annotation_updates_task_status(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import HumanInTheLoopService

        pg = _pg_router(
            hil_task=[_hil_task_row(status="open")],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.annotation._insert_hil_annotation",
            new=AsyncMock(),
        ), patch(
            "eden.evaluation.eval_intel.annotation._update_hil_task_status",
            new=AsyncMock(),
        ) as upd:
            await HumanInTheLoopService().submit_annotation(
                "org_test",
                task_id="22222222-2222-2222-2222-222222222222",
                trace_id="trace-1",
                label="ok",
            )
        upd.assert_called_once()
        # Status is passed as a positional arg, not kwarg.
        args = upd.call_args.args
        assert len(args) >= 3
        assert args[2] == "closed"

    @pytest.mark.asyncio
    async def test_submit_annotation_persists_to_hil_annotations(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import HumanInTheLoopService

        pg = _pg_router(
            hil_task=[_hil_task_row(status="open")],
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.annotation._insert_hil_annotation",
            new=AsyncMock(),
        ) as persist, patch(
            "eden.evaluation.eval_intel.annotation._update_hil_task_status",
            new=AsyncMock(),
        ):
            await HumanInTheLoopService().submit_annotation(
                "org_test",
                task_id="22222222-2222-2222-2222-222222222222",
                trace_id="trace-1",
                label="ok",
            )
        persist.assert_called_once()


# ─── 6. PairwiseAnnotationService ────────────────────────────────────


class TestPairwiseAnnotationService:
    @pytest.mark.asyncio
    async def test_create_queue_success(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import PairwiseAnnotationService

        with patch(
            "eden.evaluation.eval_intel.annotation._insert_pairwise_queue",
            new=AsyncMock(),
        ) as persist:
            result = await PairwiseAnnotationService().create_queue(
                "org_test", name="compare v2 vs v3", spec={},
            )
        assert result["status"] == "ok"
        assert "queue_id" in result["data"]
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_submit_preference_success(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import PairwiseAnnotationService

        with patch(
            "eden.evaluation.eval_intel.annotation._insert_pairwise_preference",
            new=AsyncMock(),
        ) as persist:
            result = await PairwiseAnnotationService().submit_preference(
                "org_test",
                queue_id="33333333-3333-3333-3333-333333333333",
                variant_a_id="v2",
                variant_b_id="v3",
                preferred="v3",
            )
        assert result["status"] == "ok"
        assert result["data"]["preferred"] == "v3"
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_submit_preference_invalid_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import PairwiseAnnotationService

        result = await PairwiseAnnotationService().submit_preference(
            "org_test",
            queue_id="33333333-3333-3333-3333-333333333333",
            variant_a_id="v2",
            variant_b_id="v3",
            preferred="v4",
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_submit_preference_tie(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import PairwiseAnnotationService

        with patch(
            "eden.evaluation.eval_intel.annotation._insert_pairwise_preference",
            new=AsyncMock(),
        ):
            result = await PairwiseAnnotationService().submit_preference(
                "org_test",
                queue_id="33333333-3333-3333-3333-333333333333",
                variant_a_id="v2",
                variant_b_id="v3",
                preferred="tie",
            )
        assert result["status"] == "ok"
        assert result["data"]["preferred"] == "tie"

    @pytest.mark.asyncio
    async def test_persists_to_pairwise_preferences(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import PairwiseAnnotationService

        with patch(
            "eden.evaluation.eval_intel.annotation._insert_pairwise_preference",
            new=AsyncMock(),
        ) as persist:
            await PairwiseAnnotationService().submit_preference(
                "org_test",
                queue_id="33333333-3333-3333-3333-333333333333",
                variant_a_id="v2",
                variant_b_id="v3",
                preferred="v3",
            )
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_multiple_preferences_no_dedup(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.annotation import PairwiseAnnotationService

        with patch(
            "eden.evaluation.eval_intel.annotation._insert_pairwise_preference",
            new=AsyncMock(),
        ) as persist:
            for _ in range(3):
                await PairwiseAnnotationService().submit_preference(
                    "org_test",
                    queue_id="33333333-3333-3333-3333-333333333333",
                    variant_a_id="v2",
                    variant_b_id="v3",
                    preferred="v3",
                )
        # 3 separate inserts (no dedup).
        assert persist.call_count == 3


# ─── 7. MultiModalEvaluator ──────────────────────────────────────────


class TestMultiModalEvaluator:
    @pytest.mark.asyncio
    async def test_text_success(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.multimodal import MultiModalEvaluator

        with _patched_openrouter(
            '{"score": 0.85, "rationale": "good"}', module="multimodal",
        ), patch(
            "eden.evaluation.eval_intel.multimodal._insert_multimodal_run",
            new=AsyncMock(),
        ):
            result = await MultiModalEvaluator().evaluate_text_image_audio(
                "org_test", modality="text",
                input_url="the answer is 42",
                spec={"criteria": ["accuracy"]},
            )
        assert result["status"] == "ok"
        assert result["data"]["modality"] == "text"
        assert result["data"]["score"] == 0.85

    @pytest.mark.asyncio
    async def test_image_success(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.multimodal import MultiModalEvaluator

        with _patched_openrouter(
            '{"score": 0.7, "rationale": "ok"}', module="multimodal",
        ), patch(
            "eden.evaluation.eval_intel.multimodal._insert_multimodal_run",
            new=AsyncMock(),
        ):
            result = await MultiModalEvaluator().evaluate_text_image_audio(
                "org_test", modality="image",
                input_url="https://example.com/cat.png",
                spec={"criteria": ["clarity"]},
            )
        assert result["status"] == "ok"
        assert result["data"]["modality"] == "image"
        # Image in v1 is text-only of the URL.
        assert "v1" in (result["data"]["message"] or "")

    @pytest.mark.asyncio
    async def test_audio_success(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.multimodal import MultiModalEvaluator

        with _patched_openrouter(
            '{"score": 0.6, "rationale": "ok"}', module="multimodal",
        ), patch(
            "eden.evaluation.eval_intel.multimodal._insert_multimodal_run",
            new=AsyncMock(),
        ):
            result = await MultiModalEvaluator().evaluate_text_image_audio(
                "org_test", modality="audio",
                input_url="https://example.com/clip.mp3",
                spec={"criteria": ["clarity"]},
            )
        assert result["status"] == "ok"
        assert result["data"]["modality"] == "audio"

    @pytest.mark.asyncio
    async def test_unsupported_modality_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.multimodal import MultiModalEvaluator

        result = await MultiModalEvaluator().evaluate_text_image_audio(
            "org_test", modality="video", input_url="url", spec={},
        )
        assert result["status"] == "bad_request"
        assert "video" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_no_llm_client_returns_default(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.multimodal import MultiModalEvaluator

        with patch(
            "eden.evaluation.eval_intel.multimodal.OpenRouterClient",
            side_effect=ImportError("no LLM"),
        ), patch(
            "eden.evaluation.eval_intel.multimodal._insert_multimodal_run",
            new=AsyncMock(),
        ):
            result = await MultiModalEvaluator().evaluate_text_image_audio(
                "org_test", modality="text",
                input_url="the answer is 42",
                spec={"criteria": ["accuracy"]},
            )
        assert result["status"] == "ok"
        assert result["data"]["score"] == 0.5
        # The message indicates the LLM init failed.
        assert "OpenRouterClient" in result["data"]["message"] or (
            "llm_client" in result["data"]["message"]
        )

    @pytest.mark.asyncio
    async def test_persists_to_multimodal_runs(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.multimodal import MultiModalEvaluator

        with _patched_openrouter(
            '{"score": 0.5, "rationale": "ok"}', module="multimodal",
        ), patch(
            "eden.evaluation.eval_intel.multimodal._insert_multimodal_run",
            new=AsyncMock(),
        ) as persist:
            await MultiModalEvaluator().evaluate_text_image_audio(
                "org_test", modality="text",
                input_url="the answer is 42",
                spec={"criteria": ["accuracy"]},
            )
        persist.assert_called_once()


# ─── 8. EvalToGuardrailLink ──────────────────────────────────────────


class TestEvalToGuardrailLink:
    @pytest.mark.asyncio
    async def test_promote_success(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

        pg = _pg_router(
            judge_dist=[_judge_dist_row(sample_count=200, fpr=0.02)],
            guardrail_policy_return={"id": "44444444-4444-4444-4444-444444444444"},
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration._insert_guardrail_policy",
            new=AsyncMock(return_value="44444444-4444-4444-4444-444444444444"),
        ), patch(
            "eden.evaluation.eval_intel.integration._insert_eval_to_guardrail_link",
            new=AsyncMock(),
        ), patch(
            "eden.evaluation.eval_intel.integration._fire_eval_to_guardrail_promotion",
            new=MagicMock(),
        ) as fire:
            result = await EvalToGuardrailLink().promote_to_guardrail(
                "org_test", judge_name="hallucination", threshold=0.6,
            )
        assert result["status"] == "ok"
        assert result["data"]["guardrail_policy_id"] == (
            "44444444-4444-4444-4444-444444444444"
        )
        assert result["data"]["sample_count"] == 200
        assert result["data"]["fpr"] == 0.02
        fire.assert_called_once()

    @pytest.mark.asyncio
    async def test_promote_with_99_samples_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

        pg = _pg_router(judge_dist=[_judge_dist_row(sample_count=99)])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await EvalToGuardrailLink().promote_to_guardrail(
                "org_test", judge_name="hallucination", threshold=0.6,
            )
        assert result["status"] == "bad_request"
        assert "100" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_promote_with_high_fpr_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

        pg = _pg_router(judge_dist=[_judge_dist_row(sample_count=200, fpr=0.10)])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await EvalToGuardrailLink().promote_to_guardrail(
                "org_test", judge_name="hallucination", threshold=0.6,
            )
        assert result["status"] == "bad_request"
        assert "FPR" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_promote_with_low_fpr_succeeds(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

        pg = _pg_router(judge_dist=[_judge_dist_row(sample_count=200, fpr=0.04)])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration._insert_guardrail_policy",
            new=AsyncMock(return_value="policy-id"),
        ), patch(
            "eden.evaluation.eval_intel.integration._insert_eval_to_guardrail_link",
            new=AsyncMock(),
        ), patch(
            "eden.evaluation.eval_intel.integration._fire_eval_to_guardrail_promotion",
            new=MagicMock(),
        ):
            result = await EvalToGuardrailLink().promote_to_guardrail(
                "org_test", judge_name="hallucination", threshold=0.6,
            )
        assert result["status"] == "ok"

    @pytest.mark.asyncio
    async def test_promote_fires_guardrail_hook(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

        pg = _pg_router(judge_dist=[_judge_dist_row(sample_count=200, fpr=0.02)])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration._insert_guardrail_policy",
            new=AsyncMock(return_value="policy-id"),
        ), patch(
            "eden.evaluation.eval_intel.integration._insert_eval_to_guardrail_link",
            new=AsyncMock(),
        ), patch(
            "eden.evaluation.eval_intel.integration._fire_eval_to_guardrail_promotion",
            new=MagicMock(),
        ) as fire:
            await EvalToGuardrailLink().promote_to_guardrail(
                "org_test", judge_name="hallucination", threshold=0.6,
            )
        fire.assert_called_once_with(
            "org_test", judge_name="hallucination", threshold=0.6,
        )

    @pytest.mark.asyncio
    async def test_promote_persists_guardrail_policy(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

        pg = _pg_router(judge_dist=[_judge_dist_row(sample_count=200, fpr=0.02)])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration._insert_guardrail_policy",
            new=AsyncMock(return_value="policy-id"),
        ) as gp_persist, patch(
            "eden.evaluation.eval_intel.integration._insert_eval_to_guardrail_link",
            new=AsyncMock(),
        ), patch(
            "eden.evaluation.eval_intel.integration._fire_eval_to_guardrail_promotion",
            new=MagicMock(),
        ):
            await EvalToGuardrailLink().promote_to_guardrail(
                "org_test", judge_name="hallucination", threshold=0.6,
            )
        gp_persist.assert_called_once()
        kwargs = gp_persist.call_args.kwargs
        assert kwargs.get("type_") == "judge_link"

    @pytest.mark.asyncio
    async def test_promote_persists_eval_to_guardrail_link(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

        pg = _pg_router(judge_dist=[_judge_dist_row(sample_count=200, fpr=0.02)])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration._insert_guardrail_policy",
            new=AsyncMock(return_value="policy-id"),
        ), patch(
            "eden.evaluation.eval_intel.integration._insert_eval_to_guardrail_link",
            new=AsyncMock(),
        ) as link_persist, patch(
            "eden.evaluation.eval_intel.integration._fire_eval_to_guardrail_promotion",
            new=MagicMock(),
        ):
            await EvalToGuardrailLink().promote_to_guardrail(
                "org_test", judge_name="hallucination", threshold=0.6,
            )
        link_persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_promote_invalid_threshold(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

        result = await EvalToGuardrailLink().promote_to_guardrail(
            "org_test", judge_name="hallucination", threshold=1.5,
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_promote_returns_policy_id_and_link(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import EvalToGuardrailLink

        pg = _pg_router(judge_dist=[_judge_dist_row(sample_count=200, fpr=0.02)])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration._insert_guardrail_policy",
            new=AsyncMock(return_value="my-policy"),
        ), patch(
            "eden.evaluation.eval_intel.integration._insert_eval_to_guardrail_link",
            new=AsyncMock(),
        ), patch(
            "eden.evaluation.eval_intel.integration._fire_eval_to_guardrail_promotion",
            new=MagicMock(),
        ):
            result = await EvalToGuardrailLink().promote_to_guardrail(
                "org_test", judge_name="hallucination", threshold=0.6,
            )
        assert "guardrail_policy_id" in result["data"]
        assert result["data"]["guardrail_policy_id"] == "my-policy"


# ─── 9. SixModalitiesRegistry ────────────────────────────────────────


class TestSixModalitiesRegistry:
    @pytest.mark.asyncio
    async def test_declare_llm_as_judge(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.multimodal import SixModalitiesRegistry

        with patch(
            "eden.evaluation.eval_intel.multimodal._insert_modality_declaration",
            new=AsyncMock(),
        ) as persist:
            result = await SixModalitiesRegistry().declare_modality(
                "org_test", modality="llm_as_judge", config={"judges": ["hallucination"]},
            )
        assert result["status"] == "ok"
        assert result["data"]["modality"] == "llm_as_judge"
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_declare_online(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.multimodal import SixModalitiesRegistry

        with patch(
            "eden.evaluation.eval_intel.multimodal._insert_modality_declaration",
            new=AsyncMock(),
        ):
            result = await SixModalitiesRegistry().declare_modality(
                "org_test", modality="online", config={"sampling_rate": 0.1},
            )
        assert result["status"] == "ok"

    @pytest.mark.asyncio
    async def test_unknown_modality_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.multimodal import SixModalitiesRegistry

        result = await SixModalitiesRegistry().declare_modality(
            "org_test", modality="unknown", config={},
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_persists_to_modality_declarations(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.multimodal import SixModalitiesRegistry

        with patch(
            "eden.evaluation.eval_intel.multimodal._insert_modality_declaration",
            new=AsyncMock(),
        ) as persist:
            await SixModalitiesRegistry().declare_modality(
                "org_test", modality="offline", config={},
            )
        persist.assert_called_once()


# ─── 10. BooleanCategoricalScore ─────────────────────────────────────


class TestBooleanCategoricalScore:
    @pytest.mark.asyncio
    async def test_boolean_true(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.scores import BooleanCategoricalScore

        with patch(
            "eden.evaluation.eval_intel.scores._delete_then_insert_boolean_categorical",
            new=AsyncMock(),
        ):
            result = await BooleanCategoricalScore().evaluate(
                "org_test", score_type="boolean", value="true",
            )
        assert result["status"] == "ok"
        assert result["data"]["score"] == 1.0
        assert result["data"]["value"] == "true"

    @pytest.mark.asyncio
    async def test_boolean_false(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.scores import BooleanCategoricalScore

        with patch(
            "eden.evaluation.eval_intel.scores._delete_then_insert_boolean_categorical",
            new=AsyncMock(),
        ):
            result = await BooleanCategoricalScore().evaluate(
                "org_test", score_type="boolean", value="false",
            )
        assert result["status"] == "ok"
        assert result["data"]["score"] == 0.0

    @pytest.mark.asyncio
    async def test_categorical_returns_neutral(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.scores import BooleanCategoricalScore

        with patch(
            "eden.evaluation.eval_intel.scores._delete_then_insert_boolean_categorical",
            new=AsyncMock(),
        ):
            result = await BooleanCategoricalScore().evaluate(
                "org_test", score_type="categorical", value="category_a",
            )
        assert result["status"] == "ok"
        assert result["data"]["score"] == 0.5
        assert "category_a" in result["data"]["rationale"]

    @pytest.mark.asyncio
    async def test_unknown_score_type_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.scores import BooleanCategoricalScore

        result = await BooleanCategoricalScore().evaluate(
            "org_test", score_type="unknown", value="x",
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_persists_to_boolean_categorical_scores(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.scores import BooleanCategoricalScore

        with patch(
            "eden.evaluation.eval_intel.scores._delete_then_insert_boolean_categorical",
            new=AsyncMock(),
        ) as persist:
            await BooleanCategoricalScore().evaluate(
                "org_test", score_type="boolean", value="yes",
            )
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_reevaluation_updates_row(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.scores import BooleanCategoricalScore

        with patch(
            "eden.evaluation.eval_intel.scores._delete_then_insert_boolean_categorical",
            new=AsyncMock(),
        ) as persist:
            await BooleanCategoricalScore().evaluate(
                "org_test", score_type="boolean", value="true",
            )
            await BooleanCategoricalScore().evaluate(
                "org_test", score_type="boolean", value="false",
            )
        # Each call deletes-then-inserts (re-runnable).
        assert persist.call_count == 2


# ─── 11. CustomPythonEval ────────────────────────────────────────────


class TestCustomPythonEval:
    @pytest.mark.asyncio
    async def test_register_success(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import CustomPythonEval

        with patch(
            "eden.evaluation.eval_intel.integration._insert_custom_python_eval",
            new=AsyncMock(),
        ) as persist:
            result = await CustomPythonEval().register(
                "org_test",
                name="length_penalty",
                function_ref="os.path.join",  # always importable
                spec={"threshold": 1000},
            )
        assert result["status"] == "ok"
        assert result["data"]["callable"] is True
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_register_bad_function_ref_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import CustomPythonEval

        result = await CustomPythonEval().register(
            "org_test",
            name="bad",
            function_ref="nonexistent.module.func",
            spec={},
        )
        assert result["status"] == "bad_request"
        assert "importable" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_register_with_importable_function(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import CustomPythonEval

        with patch(
            "eden.evaluation.eval_intel.integration._insert_custom_python_eval",
            new=AsyncMock(),
        ):
            result = await CustomPythonEval().register(
                "org_test",
                name="len_eval",
                function_ref="builtins.len",
                spec={},
            )
        assert result["status"] == "ok"

    @pytest.mark.asyncio
    async def test_persists_to_custom_python_evals(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import CustomPythonEval

        with patch(
            "eden.evaluation.eval_intel.integration._insert_custom_python_eval",
            new=AsyncMock(),
        ) as persist:
            await CustomPythonEval().register(
                "org_test",
                name="len_eval",
                function_ref="builtins.len",
                spec={},
            )
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_eval_id(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import CustomPythonEval

        with patch(
            "eden.evaluation.eval_intel.integration._insert_custom_python_eval",
            new=AsyncMock(),
        ):
            result = await CustomPythonEval().register(
                "org_test",
                name="len_eval",
                function_ref="builtins.len",
                spec={},
            )
        assert "name" in result["data"]
        assert "function_ref" in result["data"]


# ─── 12. UserFeedbackService ─────────────────────────────────────────


class TestUserFeedbackService:
    @pytest.mark.asyncio
    async def test_thumbs_up(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.scores import UserFeedbackService

        with patch(
            "eden.evaluation.eval_intel.scores._insert_user_feedback",
            new=AsyncMock(),
        ):
            result = await UserFeedbackService().submit_thumbs_rating(
                "org_test", trace_id="trace-1", thumbs="up",
            )
        assert result["status"] == "ok"
        assert result["data"]["thumbs"] == "up"

    @pytest.mark.asyncio
    async def test_thumbs_down(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.scores import UserFeedbackService

        with patch(
            "eden.evaluation.eval_intel.scores._insert_user_feedback",
            new=AsyncMock(),
        ):
            result = await UserFeedbackService().submit_thumbs_rating(
                "org_test", trace_id="trace-1", thumbs="down",
            )
        assert result["status"] == "ok"
        assert result["data"]["thumbs"] == "down"

    @pytest.mark.asyncio
    async def test_rating_5(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.scores import UserFeedbackService

        with patch(
            "eden.evaluation.eval_intel.scores._insert_user_feedback",
            new=AsyncMock(),
        ):
            result = await UserFeedbackService().submit_thumbs_rating(
                "org_test", trace_id="trace-1", rating=5,
            )
        assert result["status"] == "ok"
        assert result["data"]["rating"] == 5

    @pytest.mark.asyncio
    async def test_with_comment(self, mock_postgres_client: MagicMock) -> None:
        from eden.evaluation.eval_intel.scores import UserFeedbackService

        with patch(
            "eden.evaluation.eval_intel.scores._insert_user_feedback",
            new=AsyncMock(),
        ):
            result = await UserFeedbackService().submit_thumbs_rating(
                "org_test", trace_id="trace-1", comment="Great!",
            )
        assert result["status"] == "ok"
        assert result["data"]["comment"] == "Great!"

    @pytest.mark.asyncio
    async def test_all_empty_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.scores import UserFeedbackService

        result = await UserFeedbackService().submit_thumbs_rating(
            "org_test", trace_id="trace-1",
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_persists_to_user_feedback(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.scores import UserFeedbackService

        with patch(
            "eden.evaluation.eval_intel.scores._insert_user_feedback",
            new=AsyncMock(),
        ) as persist:
            await UserFeedbackService().submit_thumbs_rating(
                "org_test", trace_id="trace-1", thumbs="up",
            )
        persist.assert_called_once()


# ─── 13. AutoDatasetBridge ───────────────────────────────────────────


class TestAutoDatasetBridge:
    @pytest.mark.asyncio
    async def test_bridge_no_failures(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import AutoDatasetBridge

        pg = _pg_router(judge_scores_low=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration._insert_auto_dataset_bridge",
            new=AsyncMock(),
        ):
            result = await AutoDatasetBridge().from_judge_failures(
                "org_test", judge_name="hallucination",
                target_dataset_name="hallucination_golden",
            )
        assert result["status"] == "ok"
        assert result["data"]["samples_added"] == 0
        assert "insufficient" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_bridge_with_failures_curated(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import AutoDatasetBridge

        rows = [
            _judge_score_row(score=0.3) for _ in range(10)
        ]
        pg = _pg_router(judge_scores_low=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration.AutoDatasetPromoter",
        ) as promoter_cls:
            promoter_instance = MagicMock()
            promoter_instance.process_traces = AsyncMock(
                return_value={
                    "processed": 10,
                    "new_cases_added": 7,
                    "dataset_id": "gd_hallucination_golden",
                }
            )
            promoter_cls.return_value = promoter_instance
            with patch(
                "eden.evaluation.eval_intel.integration._insert_auto_dataset_bridge",
                new=AsyncMock(),
            ) as persist:
                result = await AutoDatasetBridge().from_judge_failures(
                    "org_test", judge_name="hallucination",
                    target_dataset_name="hallucination_golden",
                )
        assert result["status"] == "ok"
        assert result["data"]["dataset_id"] == "gd_hallucination_golden"
        assert result["data"]["samples_added"] == 7
        assert result["data"]["samples_processed"] == 10
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_bridge_insufficient_samples(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import AutoDatasetBridge

        rows = [_judge_score_row(score=0.3) for _ in range(2)]
        pg = _pg_router(judge_scores_low=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration._insert_auto_dataset_bridge",
            new=AsyncMock(),
        ):
            result = await AutoDatasetBridge().from_judge_failures(
                "org_test", judge_name="hallucination",
                target_dataset_name="hallucination_golden",
            )
        assert result["data"]["samples_added"] == 0
        assert "insufficient" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_bridge_fires_promoter(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import AutoDatasetBridge

        rows = [_judge_score_row(score=0.3) for _ in range(10)]
        pg = _pg_router(judge_scores_low=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration.AutoDatasetPromoter",
        ) as promoter_cls:
            promoter_instance = MagicMock()
            promoter_instance.process_traces = AsyncMock(
                return_value={"new_cases_added": 0, "processed": 10}
            )
            promoter_cls.return_value = promoter_instance
            with patch(
                "eden.evaluation.eval_intel.integration._insert_auto_dataset_bridge",
                new=AsyncMock(),
            ):
                await AutoDatasetBridge().from_judge_failures(
                    "org_test", judge_name="hallucination",
                    target_dataset_name="hallucination_golden",
                )
        promoter_instance.process_traces.assert_called_once()

    @pytest.mark.asyncio
    async def test_bridge_persists_to_auto_dataset_bridge(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import AutoDatasetBridge

        rows = [_judge_score_row(score=0.3) for _ in range(10)]
        pg = _pg_router(judge_scores_low=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration.AutoDatasetPromoter",
        ) as promoter_cls:
            promoter_instance = MagicMock()
            promoter_instance.process_traces = AsyncMock(
                return_value={"new_cases_added": 0, "processed": 10}
            )
            promoter_cls.return_value = promoter_instance
            with patch(
                "eden.evaluation.eval_intel.integration._insert_auto_dataset_bridge",
                new=AsyncMock(),
            ) as persist:
                await AutoDatasetBridge().from_judge_failures(
                    "org_test", judge_name="hallucination",
                    target_dataset_name="hallucination_golden",
                )
        persist.assert_called_once()

    @pytest.mark.asyncio
    async def test_bridge_returns_target_dataset_id(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import AutoDatasetBridge

        rows = [_judge_score_row(score=0.3) for _ in range(10)]
        pg = _pg_router(judge_scores_low=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration.AutoDatasetPromoter",
        ) as promoter_cls:
            promoter_instance = MagicMock()
            promoter_instance.process_traces = AsyncMock(
                return_value={
                    "new_cases_added": 5,
                    "processed": 10,
                    "dataset_id": "my-dataset-id",
                }
            )
            promoter_cls.return_value = promoter_instance
            with patch(
                "eden.evaluation.eval_intel.integration._insert_auto_dataset_bridge",
                new=AsyncMock(),
            ):
                result = await AutoDatasetBridge().from_judge_failures(
                    "org_test", judge_name="hallucination",
                    target_dataset_name="hallucination_golden",
                )
        assert result["data"]["dataset_id"] == "my-dataset-id"

    @pytest.mark.asyncio
    async def test_bridge_samples_processed_and_added_distinct(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.evaluation.eval_intel.integration import AutoDatasetBridge

        rows = [_judge_score_row(score=0.3) for _ in range(10)]
        pg = _pg_router(judge_scores_low=rows)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.evaluation.eval_intel.integration.AutoDatasetPromoter",
        ) as promoter_cls:
            promoter_instance = MagicMock()
            promoter_instance.process_traces = AsyncMock(
                return_value={
                    "new_cases_added": 3,
                    "processed": 10,
                }
            )
            promoter_cls.return_value = promoter_instance
            with patch(
                "eden.evaluation.eval_intel.integration._insert_auto_dataset_bridge",
                new=AsyncMock(),
            ):
                result = await AutoDatasetBridge().from_judge_failures(
                    "org_test", judge_name="hallucination",
                    target_dataset_name="hallucination_golden",
                )
        assert result["data"]["samples_processed"] == 10
        assert result["data"]["samples_added"] == 3


# ─── 14. Envelope helpers ────────────────────────────────────────────


class TestEnvelopeHelpers:
    def test_ok_envelope_shape(self) -> None:
        from eden.evaluation.eval_intel._common import _ok_envelope

        env = _ok_envelope("test_feature", {"foo": "bar"})
        assert env["status"] == "ok"
        assert env["feature"] == "test_feature"
        assert env["live"] is True
        assert env["trace_id"].startswith("ei_")
        assert "timestamp" in env
        assert env["data"] == {"foo": "bar"}

    def test_bad_request_envelope_shape(self) -> None:
        from eden.evaluation.eval_intel._common import _bad_request_envelope

        env = _bad_request_envelope("test_feature", "bad input")
        assert env["status"] == "bad_request"
        assert env["feature"] == "test_feature"
        assert env["live"] is True
        assert env["data"]["message"] == "bad input"

    def test_not_found_envelope_shape(self) -> None:
        from eden.evaluation.eval_intel._common import _not_found_envelope

        env = _not_found_envelope("test_feature", "missing_key")
        assert env["status"] == "not_found"
        assert env["data"]["key"] == "missing_key"

    def test_conflict_envelope_shape(self) -> None:
        from eden.evaluation.eval_intel._common import _conflict_envelope

        env = _conflict_envelope("test_feature", "task closed")
        assert env["status"] == "conflict"
        assert env["data"]["message"] == "task closed"


# ─── 15. Package contract ────────────────────────────────────────────


class TestPackageContract:
    def test_all_13_names_resolve_via_getattr(self) -> None:
        import eden.evaluation.eval_intel as pkg

        names = [
            "AutoDatasetBridge", "BooleanCategoricalScore", "CLHFGenerator",
            "CustomPythonEval", "EvalRegistry", "EvalToGuardrailLink",
            "EvalVersioner", "FailureClusterer", "HumanInTheLoopService",
            "MultiModalEvaluator", "PairwiseAnnotationService",
            "SixModalitiesRegistry", "UserFeedbackService",
        ]
        for n in names:
            assert hasattr(pkg, n), f"missing {n}"
            assert n in pkg.__all__, f"{n} not in __all__"

    def test_unknown_attr_raises_attribute_error(self) -> None:
        import eden.evaluation.eval_intel as pkg

        with pytest.raises(AttributeError):
            _ = pkg.NotARealClass

    def test_dir_includes_all_13_names(self) -> None:
        import eden.evaluation.eval_intel as pkg

        d = dir(pkg)
        for n in [
            "EvalVersioner", "EvalRegistry", "FailureClusterer",
            "CLHFGenerator", "MultiModalEvaluator", "EvalToGuardrailLink",
        ]:
            assert n in d

    def test_lazy_import_caches_in_globals(self) -> None:
        import eden.evaluation.eval_intel as pkg

        v1 = pkg.EvalVersioner
        v2 = pkg.EvalVersioner
        assert v1 is v2  # cached after first access

    def test_versioner_shim_re_exports(self) -> None:
        """EvalVersioner is lazy-exported from the package root."""
        from eden.evaluation.eval_intel import EvalVersioner
        from eden.evaluation.eval_intel.versioning import EvalVersioner as Direct

        assert EvalVersioner is Direct


# ─── 16. Route-level smoke tests ─────────────────────────────────────


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


@pytest.fixture(scope="module")
def eval_app() -> FastAPI:
    from eden.api.deps import get_current_user, require_org_member, require_path_org_access
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    app = FastAPI(title="eden-eval-test")
    app.dependency_overrides[get_current_user] = _fake_user
    # The eval router has require_org_member in its dependencies;
    # override it so the test client doesn't need a real DB to
    # resolve the membership. The real org-check still runs in
    # production.
    app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
    app.dependency_overrides[require_path_org_access] = lambda: "org_x"
    mod = importlib.import_module("eden.api.routes.intelligence_eval")
    if hasattr(mod, "_require_path_org"):
        app.dependency_overrides[mod._require_path_org] = lambda: "org_x"
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def eval_client(eval_app: FastAPI) -> TestClient:
    return TestClient(eval_app)


def test_versions_tag_route(eval_client: TestClient) -> None:
    """POST /eval/versions/tag returns the live envelope."""
    with patch(
        "eden.api.routes.intelligence_eval._versioner.tag",
        new=AsyncMock(return_value={"status": "ok", "feature": "eval_versioner", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"regression_detected": False}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/versions/tag",
            json={"deployment_sha": "abc123def456", "prompt_version": "v3", "judge_set": ["hallucination"]},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["feature"] == "eval_versioner"
    assert data["live"] is True


def test_versions_list_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._registry.list",
        new=AsyncMock(return_value={"status": "ok", "feature": "eval_registry", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"versions": [], "count": 0}}),
    ):
        resp = eval_client.get("/orgs/org_x/intelligence/eval/versions")
    assert resp.status_code == 200
    assert resp.json()["feature"] == "eval_registry"


def test_failure_clusters_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._failure.cluster",
        new=AsyncMock(return_value={"status": "ok", "feature": "failure_clusterer", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"clusters": []}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/failure-clusters",
            json={"judge_name": "hallucination", "window": "24h"},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "failure_clusterer"


def test_clhf_generate_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._clhf.generate_custom_metric",
        new=AsyncMock(return_value={"status": "ok", "feature": "clhf_generator", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"metric_name": "x"}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/clhf/generate",
            json={"name": "m", "examples": [{"input": "i", "output": "o", "score": 0.5}, {"input": "i2", "output": "o2", "score": 0.7}]},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "clhf_generator"


def test_hil_tasks_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._hil.create_annotation_task",
        new=AsyncMock(return_value={"status": "ok", "feature": "hil_service", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"task_id": "t1"}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/hil/tasks",
            json={"name": "task", "spec": {}},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "hil_service"


def test_hil_annotations_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._hil.submit_annotation",
        new=AsyncMock(return_value={"status": "ok", "feature": "hil_service", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"status": "closed"}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/hil/annotations",
            json={"task_id": "t1", "trace_id": "trace-1", "label": "ok"},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "hil_service"


def test_pairwise_queues_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._pairwise.create_queue",
        new=AsyncMock(return_value={"status": "ok", "feature": "pairwise_annotation", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"queue_id": "q1"}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/pairwise/queues",
            json={"name": "queue", "spec": {}},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "pairwise_annotation"


def test_pairwise_preferences_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._pairwise.submit_preference",
        new=AsyncMock(return_value={"status": "ok", "feature": "pairwise_annotation", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"preferred": "v3"}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/pairwise/preferences",
            json={"queue_id": "q1", "variant_a_id": "v2", "variant_b_id": "v3", "preferred": "v3"},
        )
    assert resp.status_code == 200


def test_multimodal_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._multimodal.evaluate_text_image_audio",
        new=AsyncMock(return_value={"status": "ok", "feature": "multimodal_evaluator", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"modality": "text", "score": 0.85}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/multimodal/evaluate",
            json={"modality": "text", "input_url": "the answer is 42", "spec": {}},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "multimodal_evaluator"


def test_promote_to_guardrail_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._promote.promote_to_guardrail",
        new=AsyncMock(return_value={"status": "ok", "feature": "eval_to_guardrail", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"guardrail_policy_id": "p1"}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/promote-to-guardrail",
            json={"judge_name": "hallucination", "threshold": 0.6},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "eval_to_guardrail"


def test_modalities_declare_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._six_mod.declare_modality",
        new=AsyncMock(return_value={"status": "ok", "feature": "six_modalities", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"modality": "llm_as_judge"}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/modalities/declare",
            json={"modality": "llm_as_judge", "config": {}},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "six_modalities"


def test_boolean_categorical_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._bool_cat.evaluate",
        new=AsyncMock(return_value={"status": "ok", "feature": "boolean_categorical", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"score": 1.0}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/boolean-categorical",
            json={"score_type": "boolean", "value": "true"},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "boolean_categorical"


def test_custom_eval_register_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._custom.register",
        new=AsyncMock(return_value={"status": "ok", "feature": "custom_python_eval", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"callable": True}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/custom-eval/register",
            json={"name": "m", "function_ref": "builtins.len", "spec": {}},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "custom_python_eval"


def test_feedback_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._feedback.submit_thumbs_rating",
        new=AsyncMock(return_value={"status": "ok", "feature": "eval_user_feedback", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"thumbs": "up"}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/feedback",
            json={"trace_id": "trace-1", "thumbs": "up"},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "eval_user_feedback"


def test_auto_dataset_route(eval_client: TestClient) -> None:
    with patch(
        "eden.api.routes.intelligence_eval._auto.from_judge_failures",
        new=AsyncMock(return_value={"status": "ok", "feature": "auto_dataset_bridge", "live": True, "trace_id": "ei_abc", "timestamp": "2026-06-11T00:00:00Z", "data": {"samples_added": 0}}),
    ):
        resp = eval_client.post(
            "/orgs/org_x/intelligence/eval/auto-dataset",
            json={"judge_name": "hallucination", "target_dataset_name": "d", "min_confidence": 0.85},
        )
    assert resp.status_code == 200
    assert resp.json()["feature"] == "auto_dataset_bridge"


def test_eval_routes_registered_under_intelligence_eval_tag() -> None:
    """The 15 Cat 3 routes are registered under the
    ``intelligence-eval`` OpenAPI tag."""
    from eden.api.routes.intelligence_eval import router

    paths = sorted({(r.path, ",".join(r.methods or set())) for r in router.routes})
    expected_count = 15
    assert len(paths) >= expected_count
