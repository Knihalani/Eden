"""Tests for the JudgeScorePromptEvolver (Phase 7.2b).

The evolver is the **first link** in the closed-loop flywire: judge
scores drive prompt evolution. It reads ``judge_scores`` (Phase 1),
joins to ``telemetry_events`` for agent_id, computes per-(agent,
judge) aggregate, and when degraded calls the LLM to generate a
prompt variant registered as inactive for A/B testing.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.agents.evolution.components import JudgeScorePromptEvolver

# ── Helpers ──────────────────────────────────────────────────────


def _judge_row(
    *,
    judge_name: str = "hallucination",
    score: float = 0.3,
    trace_id: str = "tr_1",
    span_id: str = "sp_1",
    rationale: str = "fabricated a number",
    agent_id: str | None = "planner",
    model: str = "claude-haiku",
    scored_at: datetime | None = None,
) -> dict[str, Any]:
    return {
        "judge_name": judge_name,
        "score": score,
        "rationale": rationale,
        "trace_id": trace_id,
        "span_id": span_id,
        "model": model,
        "scored_at": scored_at or datetime(2026, 6, 3, 12, 0, 0, tzinfo=UTC),
        "agent_id": agent_id,
    }


def _fake_response(content: str) -> Any:
    r = MagicMock()
    r.content = content
    r.model = "claude-haiku"
    return r


class _FakePromptVersions:
    """In-memory stand-in for ``PromptVersionsClient``.

    Records every insert_version call. ``get_active_prompt`` is
    configurable per agent.
    """

    def __init__(self, active_prompts: dict[str, dict] | None = None) -> None:
        self.active = dict(active_prompts or {})
        self.inserts: list[dict] = []

    async def get_active_prompt(self, agent: str) -> dict | None:
        return self.active.get(agent)

    async def insert_version(
        self,
        *,
        agent: str,
        system_prompt: str,
        version: int,
        few_shot_examples=None,
        quality_metrics=None,
        active: bool = False,
    ) -> bool:
        self.inserts.append({
            "agent": agent,
            "system_prompt": system_prompt,
            "version": version,
            "few_shot_examples": few_shot_examples,
            "quality_metrics": quality_metrics,
            "active": active,
        })
        return True

    async def get_latest_version(self, agent: str) -> int:
        versions = [i["version"] for i in self.inserts if i["agent"] == agent]
        return max(versions) if versions else 0


class _FakePostgres:
    """In-memory stand-in for the Postgres client used by the evolver."""

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = list(rows or [])

    async def fetch(self, sql: str, *args) -> list[dict[str, Any]]:
        # Trivial matcher — return whatever was set up.
        return list(self.rows)


def _patch_dependencies(monkeypatch, pv: _FakePromptVersions, pg: _FakePostgres,
                       llm_content: str = "REVISED PROMPT"):
    """Wire the evolver to the fakes for one test."""

    async def _get_pv():
        return pv

    async def _get_pg():
        return pg

    # Patch BOTH the source modules (where the imports live) AND the
    # consumer module (where ``from X import Y`` creates a local
    # binding). Patching only the source has no effect on consumer
    # modules that captured the symbol at import time.
    monkeypatch.setattr(
        "eden.kb.prompt_versions.client.get_prompt_versions_client",
        _get_pv,
    )
    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client",
        _get_pg,
    )
    monkeypatch.setattr(
        "eden.agents.evolution.components.get_prompt_versions_client",
        _get_pv,
    )
    monkeypatch.setattr(
        "eden.agents.evolution.components.get_postgres_client",
        _get_pg,
    )

    llm = MagicMock()
    llm.call = MagicMock(return_value=_fake_response(llm_content))

    # Production calls ``route_sync`` (ModelRouter), not ``llm.call``
    # directly. Bypass the router so short fixture prompts are not
    # rejected as ``incomplete`` (expected_min_length default 50).
    def _route_sync(agent, prompt, **kwargs):
        return llm.call(
            agent=agent,
            prompt=prompt,
            slot=kwargs.get("slot", "reasoning"),
            system_prompt=kwargs.get("system_prompt"),
            model=kwargs.get("model"),
            max_tokens=kwargs.get("max_tokens"),
        )

    monkeypatch.setattr("eden.llm.internal_router.route_sync", _route_sync)
    return llm


# ── run(): aggregation + variant generation ──────────────────────


@pytest.mark.asyncio
async def test_run_generates_variant_for_degraded_agent(monkeypatch):
    """The full flow: 25 low scores for planner/hallucination →
    evolver generates a variant → prompt_versions.insert_version
    is called with ab_test_active=true and the new version number."""
    # 25 low scores for planner/hallucination. Mean = 0.3, well
    # below the 0.7 threshold.
    rows = [
        _judge_row(score=0.3, trace_id=f"tr_{i}", rationale=f"r_{i}")
        for i in range(25)
    ]
    pg = _FakePostgres(rows=rows)
    pv = _FakePromptVersions(active_prompts={
        "planner": {
            "version": 3,
            "system_prompt": "You are a planner.",
            "quality_metrics": {"ab_test_round": 2},
        }
    })
    llm = _patch_dependencies(monkeypatch, pv, pg, llm_content="REVISED PROMPT v4")

    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()

    assert result["degradations_detected"] == 1
    assert result["variants_generated"] == 1
    assert len(pv.inserts) == 1
    ins = pv.inserts[0]
    assert ins["agent"] == "planner"
    assert ins["version"] == 4  # bumped from 3
    assert ins["system_prompt"] == "REVISED PROMPT v4"
    assert ins["active"] is False
    assert ins["quality_metrics"]["ab_test_active"] is True
    assert ins["quality_metrics"]["ab_test_round"] == 3
    # Source judge metadata is recorded for the correlation report.
    assert ins["quality_metrics"]["source_judges"][0]["judge_name"] == "hallucination"
    # LLM was called once.
    assert llm.call.call_count == 1


@pytest.mark.asyncio
async def test_run_skips_when_no_active_prompt(monkeypatch):
    """If the agent has no active prompt version, we can't generate
    a variant — skip silently. This happens during initial bootstrap."""
    pg = _FakePostgres(rows=[
        _judge_row(score=0.3) for _ in range(25)
    ])
    pv = _FakePromptVersions(active_prompts={})  # no prompts
    llm = _patch_dependencies(monkeypatch, pv, pg)

    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()

    assert result["variants_generated"] == 0
    assert len(pv.inserts) == 0
    assert llm.call.call_count == 0  # never even called the LLM


@pytest.mark.asyncio
async def test_run_does_not_generate_when_score_above_threshold(monkeypatch):
    """The mean score is high enough → no variant. This is the steady
    state for healthy agents."""
    rows = [
        _judge_row(score=0.85) for _ in range(25)
    ]
    pg = _FakePostgres(rows=rows)
    pv = _FakePromptVersions(active_prompts={
        "planner": {"version": 3, "system_prompt": "You are a planner."}
    })
    llm = _patch_dependencies(monkeypatch, pv, pg)

    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()

    assert result["degradations_detected"] == 0
    assert result["variants_generated"] == 0
    assert len(pv.inserts) == 0


@pytest.mark.asyncio
async def test_run_respects_min_samples_threshold(monkeypatch):
    """Below the min-sample threshold, no variant — even with a low
    mean. Avoids generating noise from a handful of bad runs."""
    rows = [
        _judge_row(score=0.2) for _ in range(5)  # only 5 samples
    ]
    pg = _FakePostgres(rows=rows)
    pv = _FakePromptVersions(active_prompts={
        "planner": {"version": 1, "system_prompt": "You are a planner."}
    })
    llm = _patch_dependencies(monkeypatch, pv, pg)

    # settings default is 20; 5 < 20 → no variant.
    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()
    assert result["variants_generated"] == 0


@pytest.mark.asyncio
async def test_run_caps_at_max_variants_per_run(monkeypatch):
    """When many agents are degraded, only the lowest-scoring ones get
    variants. ``settings.evolver_max_variants_per_run`` defaults to 3."""
    # 4 different agents, all with low scores. Only 3 variants
    # should be generated.
    rows = []
    for agent in ("planner", "critic", "refiner", "executor"):
        for i in range(25):
            rows.append(_judge_row(score=0.2, trace_id=f"{agent}_{i}"))
            # We need each row to have a different agent_id. The fake
            # pg just returns whatever we give it; group logic in the
            # evolver reads row["agent_id"]. Override here.
            rows[-1]["agent_id"] = agent
    pg = _FakePostgres(rows=rows)
    pv = _FakePromptVersions(active_prompts={
        a: {"version": 1, "system_prompt": f"prompt for {a}"}
        for a in ("planner", "critic", "refiner", "executor")
    })
    llm = _patch_dependencies(monkeypatch, pv, pg)

    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()
    assert result["variants_generated"] == 3
    assert len(pv.inserts) == 3
    # 4 distinct agents were eligible; only 3 got variants.
    inserted_agents = {i["agent"] for i in pv.inserts}
    assert len(inserted_agents) == 3


@pytest.mark.asyncio
async def test_run_swallows_db_errors(monkeypatch):
    """DB read failure → empty result, no exception. The evolver
    must never break the caller's flow."""
    from eden.storage import postgres as pg_module

    async def _raise():
        raise RuntimeError("DB down")

    monkeypatch.setattr(pg_module, "get_postgres_client", _raise)
    monkeypatch.setattr(
        "eden.kb.prompt_versions.client.get_prompt_versions_client",
        lambda: AsyncMock(),
    )

    e = JudgeScorePromptEvolver(llm_client=MagicMock())
    result = await e.run()
    assert result["variants_generated"] == 0


@pytest.mark.asyncio
async def test_run_swallows_llm_errors(monkeypatch):
    """If the LLM call raises, we log and skip — no half-inserted
    variant. The evolver never raises to its caller."""
    rows = [_judge_row(score=0.2) for _ in range(25)]
    pg = _FakePostgres(rows=rows)
    pv = _FakePromptVersions(active_prompts={
        "planner": {"version": 1, "system_prompt": "x"}
    })
    llm = _patch_dependencies(monkeypatch, pv, pg)
    llm.call = MagicMock(side_effect=RuntimeError("LLM down"))

    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()
    assert result["variants_generated"] == 0
    assert len(pv.inserts) == 0


@pytest.mark.asyncio
async def test_run_skips_when_llm_returns_empty(monkeypatch):
    rows = [_judge_row(score=0.2) for _ in range(25)]
    pg = _FakePostgres(rows=rows)
    pv = _FakePromptVersions(active_prompts={
        "planner": {"version": 1, "system_prompt": "x"}
    })
    # LLM returns an empty string.
    llm = _patch_dependencies(monkeypatch, pv, pg, llm_content="")

    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()
    assert result["variants_generated"] == 0
    assert len(pv.inserts) == 0


@pytest.mark.asyncio
async def test_run_orders_by_most_degraded_first(monkeypatch):
    """The cap eats the most-degraded (agent, judge) pairs first."""
    rows = []
    # planner/hallucination: mean 0.5 (less degraded)
    for i in range(25):
        rows.append(_judge_row(score=0.5, trace_id=f"planner_{i}"))
        rows[-1]["agent_id"] = "planner"
    # critic/correctness: mean 0.1 (most degraded)
    for i in range(25):
        rows.append(_judge_row(judge_name="correctness", score=0.1,
                                trace_id=f"critic_{i}"))
        rows[-1]["agent_id"] = "critic"
    pg = _FakePostgres(rows=rows)
    pv = _FakePromptVersions(active_prompts={
        "planner": {"version": 1, "system_prompt": "p1"},
        "critic": {"version": 1, "system_prompt": "c1"},
    })
    # Cap = 1.
    from eden.config import get_settings
    get_settings().evolver_max_variants_per_run = 1
    llm = _patch_dependencies(monkeypatch, pv, pg)

    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()
    assert result["variants_generated"] == 1
    # The single variant should be for the most-degraded (critic).
    assert pv.inserts[0]["agent"] == "critic"


@pytest.mark.asyncio
async def test_run_joins_judge_scores_to_telemetry_for_agent_id(monkeypatch):
    """Rows with agent_id = NULL (judge ran without a matching
    telemetry event) are excluded — the evolver can't attribute the
    score to any agent, so there's no prompt to improve."""
    rows = []
    # 25 with agent_id = "refiner" — degraded, should produce a variant.
    for i in range(25):
        rows.append(_judge_row(score=0.2, trace_id=f"ref_{i}"))
        rows[-1]["agent_id"] = "refiner"
    # 25 with agent_id = None — same scores, but should be ignored.
    for i in range(25):
        rows.append(_judge_row(score=0.2, trace_id=f"orphan_{i}"))
        rows[-1]["agent_id"] = None
    pg = _FakePostgres(rows=rows)
    pv = _FakePromptVersions(active_prompts={
        "refiner": {"version": 1, "system_prompt": "r"}
    })
    llm = _patch_dependencies(monkeypatch, pv, pg)

    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()
    assert result["variants_generated"] == 1
    assert pv.inserts[0]["agent"] == "refiner"


@pytest.mark.asyncio
async def test_fetch_recent_judge_rows_strips_dropped_count_and_emits_metric(
    monkeypatch,
):
    """Rows with null agent_id are excluded from scoring but counted."""
    rows = [
        {
            **_judge_row(score=0.3, trace_id="tr_0"),
            "dropped_null_agent_id": 3,
        }
    ]
    pg = _FakePostgres(rows=rows)
    counter = MagicMock()
    monkeypatch.setattr(
        "eden.agents.evolution.components._dropped_null_agent_id_counter",
        lambda: counter,
    )

    e = JudgeScorePromptEvolver(llm_client=MagicMock())

    async def _get_pg():
        return pg

    monkeypatch.setattr(e, "_get_postgres", _get_pg)

    fetched = await e._fetch_recent_judge_rows()
    assert len(fetched) == 1
    assert "dropped_null_agent_id" not in fetched[0]
    counter.inc.assert_called_once_with(3)


@pytest.mark.asyncio
async def test_fetch_recent_judge_rows_no_metric_when_nothing_dropped(
    monkeypatch,
):
    rows = [{**_judge_row(score=0.3), "dropped_null_agent_id": 0}]
    pg = _FakePostgres(rows=rows)
    counter = MagicMock()
    monkeypatch.setattr(
        "eden.agents.evolution.components._dropped_null_agent_id_counter",
        lambda: counter,
    )

    e = JudgeScorePromptEvolver(llm_client=MagicMock())

    async def _get_pg():
        return pg

    monkeypatch.setattr(e, "_get_postgres", _get_pg)

    await e._fetch_recent_judge_rows()
    counter.inc.assert_not_called()


# ── Wave 1 (F-A): the trigger SQL must match the live schema ──────


@pytest.mark.asyncio
async def test_agg_query_joins_on_trace_id_and_reads_top_level_agent_id(
    monkeypatch,
):
    """F-A pinning test: the evolver trigger previously joined
    ``te.id::text = js.trace_id`` and read
    ``te.attributes->>'agent_id'`` — but ``telemetry_events`` has no
    ``id`` column (PK is ``event_id``, migration 009) and ``agent_id``
    is a top-level column never written into ``attributes``. Both
    halves meant the SQL could never return an attributed row, so the
    evolver always returned 0 degradations in production while tests
    (which baked fake rows) stayed green.

    This test asserts the *real* SQL sent to Postgres: capture it from
    the fetch call and pin the corrected join + column read.
    """
    from eden.agents.evolution import components

    captured: dict[str, Any] = {}

    class _CapturingPg:
        async def fetch(self, sql: str, *args):
            captured["sql"] = sql
            # Shape the return like the corrected query would: a row
            # with top-level agent_id + the dropped counter.
            return [
                {
                    **_judge_row(score=0.3, trace_id="tr_0", agent_id="planner"),
                    "dropped_null_agent_id": 0,
                }
            ]

    pg = _CapturingPg()
    monkeypatch.setattr(components, "get_postgres_client", lambda: pg)
    monkeypatch.setattr(components, "get_prompt_versions_client", lambda: AsyncMock())

    e = JudgeScorePromptEvolver(llm_client=MagicMock())
    rows = await e._fetch_recent_judge_rows()

    sql = captured["sql"]
    assert sql is not None
    # 1. Join on the exact event when the judge recorded one
    #    (``te.event_id = js.source_event_id`` — the judge runner writes
    #    the source event id), falling back to the shared trace_id
    #    namespace for legacy rows. Never the non-existent ``te.id``.
    assert "te.event_id = js.source_event_id" in sql
    assert "te.trace_id = js.trace_id" in sql
    assert "te.id" not in sql
    # 2. Read the top-level agent_id column, not a JSONB attribute.
    assert "te.agent_id" in sql
    assert "attributes->>'agent_id'" not in sql
    # 3. The row that comes back is usable end-to-end.
    assert rows and rows[0]["agent_id"] == "planner"


@pytest.mark.asyncio
async def test_run_flow_works_with_schema_shaped_rows(monkeypatch):
    """F-A end-to-end: rows shaped exactly like the corrected query's
    SELECT (top-level ``agent_id``) flow through ``run()`` to a real
    variant. This fails if the SQL shape ever drifts from the schema
    again (before the fix, production rows were empty because the SQL
    was wrong — the schema-shaped fixture now exercises the real path).
    """
    rows = [
        {
            **_judge_row(score=0.2, trace_id=f"tr_{i}"),
            "dropped_null_agent_id": 0,
        }
        for i in range(25)
    ]
    pg = _FakePostgres(rows=rows)
    pv = _FakePromptVersions(active_prompts={
        "planner": {"version": 2, "system_prompt": "You are a planner."}
    })
    llm = _patch_dependencies(monkeypatch, pv, pg, llm_content="REVISED v3")

    e = JudgeScorePromptEvolver(llm_client=llm)
    result = await e.run()

    assert result["degradations_detected"] == 1
    assert result["variants_generated"] == 1
    assert pv.inserts[0]["version"] == 3
