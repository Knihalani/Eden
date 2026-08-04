"""F49 backend — span hydration, concurrent matrix, scorers, run events."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

import pytest

from eden.playground.scorers import aggregate_score, run_scorers
from eden.playground.service import PlaygroundService
from eden.playground.span_seed import extract_span_seed
from eden.prompts.registry import PlaygroundResult

# ── helpers ─────────────────────────────────────────────────


def _step(payload: dict[str, Any]) -> dict[str, Any]:
    """A realistic telemetry_events agent.step row."""
    return {
        "event_id": "ev_1",
        "trace_id": "tr_1",
        "span_id": "sp_1",
        "name": "agent.step",
        "payload": payload,
        "attributes": {},
        "duration_ms": 12.0,
        "timestamp": "2026-08-01T00:00:00+00:00",
    }


def _result(prompt_dict: dict[str, Any], *, cost: float = 0.001) -> PlaygroundResult:
    return PlaygroundResult(
        template_name="",
        template_version=0,
        model=str(prompt_dict.get("model") or "t1"),
        response=f"echo:{prompt_dict.get('user')}",
        latency_ms=1.0,
        prompt_tokens=1,
        completion_tokens=1,
        cost_usd=cost,
        created_at="2026-08-01T00:00:00+00:00",
    )


def _tasks(n: int = 2) -> list[dict[str, Any]]:
    return [
        {
            "id": f"task_{i}",
            "label": f"T{i}",
            "system": "",
            "user": "{{user}}",
            "model": "t1",
            "tools": [],
        }
        for i in range(n)
    ]


async def _make_playground(
    svc: PlaygroundService, org_id: str, config: dict[str, Any]
) -> str:
    rec = await svc.create(org_id, name="pg", config=config)
    return rec.id


# ── from-span hydration ─────────────────────────────────────


@pytest.mark.asyncio
async def test_from_span_hydrates_from_stored_request() -> None:
    seen: dict[str, Any] = {}

    async def fetcher(
        *, org_id: str, trace_id: str, span_id: str | None
    ) -> dict[str, Any]:
        seen.update(org_id=org_id, trace_id=trace_id, span_id=span_id)
        return _step(
            {
                "request": {
                    "messages": [
                        {"role": "system", "content": "be terse"},
                        {
                            "role": "user",
                            "content": [{"type": "text", "text": "hi there"}],
                        },
                    ],
                    "model": "openai/gpt-test",
                    "tools": [{"name": "search"}],
                    "temperature": 0.2,
                }
            }
        )

    svc = PlaygroundService(memory_only=True, span_fetcher=fetcher)
    rec = await svc.from_span("org_f49", trace_id="tr_1", span_id="sp_1")
    assert seen == {"org_id": "org_f49", "trace_id": "tr_1", "span_id": "sp_1"}
    task = rec.config["tasks"][0]
    assert task["system"] == "be terse"
    assert task["user"] == "hi there"
    assert task["model"] == "openai/gpt-test"
    assert task["tools"] == [{"name": "search"}]
    assert rec.config["params"] == {"temperature": 0.2}
    assert rec.config["source"] == {"trace_id": "tr_1", "span_id": "sp_1"}


@pytest.mark.asyncio
async def test_from_span_prefers_explicit_prompt_over_messages() -> None:
    async def fetcher(**_kw: Any) -> dict[str, Any]:
        return _step(
            {
                "prompt": "edited prompt",
                "system_prompt": "sys rules",
                "messages": [{"role": "user", "content": "stale original"}],
                "model": "m-explicit",
            }
        )

    svc = PlaygroundService(memory_only=True, span_fetcher=fetcher)
    rec = await svc.from_span("org_f49", trace_id="tr_1", span_id="sp_1")
    task = rec.config["tasks"][0]
    assert task["user"] == "edited prompt"
    assert task["system"] == "sys rules"
    assert task["model"] == "m-explicit"


@pytest.mark.asyncio
async def test_from_span_without_usable_content_raises() -> None:
    async def fetcher(**_kw: Any) -> dict[str, Any]:
        return _step({"response": {"text": "only an output, no request"}})

    svc = PlaygroundService(memory_only=True, span_fetcher=fetcher)
    with pytest.raises(ValueError, match="no usable prompt content"):
        await svc.from_span("org_f49", trace_id="tr_1", span_id="sp_1")


@pytest.mark.asyncio
async def test_from_span_client_messages_are_fallback_only() -> None:
    async def fetcher(**_kw: Any) -> None:
        return None

    svc = PlaygroundService(memory_only=True, span_fetcher=fetcher)
    rec = await svc.from_span(
        "org_f49",
        trace_id="tr_2",
        messages=[{"role": "user", "content": "client text"}],
        model="t3",
    )
    task = rec.config["tasks"][0]
    assert task["user"] == "client text"
    assert task["model"] == "t3"


def test_extract_span_seed_no_content_returns_none() -> None:
    assert extract_span_seed(_step({})) is None
    assert extract_span_seed(_step({"messages": [{"role": "user", "content": ""}]})) is None
    assert extract_span_seed({"payload": "not-json{"}) is None


def test_extract_span_seed_json_string_payload() -> None:
    seed = extract_span_seed(
        {"payload": '{"request": {"messages": [{"role": "user", "content": "hi"}], "model": "m1"}}'}
    )
    assert seed is not None
    assert seed["messages"] == [{"role": "user", "content": "hi"}]
    assert seed["model"] == "m1"


# ── concurrent run matrix ───────────────────────────────────


@pytest.mark.asyncio
async def test_run_respects_concurrency_bound() -> None:
    state = {"inflight": 0, "max_inflight": 0}

    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        state["inflight"] += 1
        state["max_inflight"] = max(state["max_inflight"], state["inflight"])
        try:
            await asyncio.sleep(0.01)
            return _result(prompt_dict)
        finally:
            state["inflight"] -= 1

    svc = PlaygroundService(memory_only=True)
    pid = await _make_playground(
        svc, "org_c", {"tasks": _tasks(2), "scorers": [], "concurrency": 3}
    )
    rows = [{"id": f"r{i}", "input": f"in{i}"} for i in range(6)]
    with patch(
        "eden.playground.service.make_playground_handler",
        new=lambda org_id: handler,
    ):
        result = await svc.run("org_c", pid, dataset_rows=rows)
    assert result["status"] == "completed"
    assert result["row_count"] == 6
    assert state["max_inflight"] == 3


@pytest.mark.asyncio
async def test_run_clamps_concurrency_to_ten() -> None:
    state = {"inflight": 0, "max_inflight": 0}

    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        state["inflight"] += 1
        state["max_inflight"] = max(state["max_inflight"], state["inflight"])
        try:
            await asyncio.sleep(0.01)
            return _result(prompt_dict)
        finally:
            state["inflight"] -= 1

    svc = PlaygroundService(memory_only=True)
    pid = await _make_playground(
        svc, "org_c", {"tasks": _tasks(2), "scorers": [], "concurrency": 99}
    )
    rows = [{"id": f"r{i}", "input": f"in{i}"} for i in range(12)]
    with patch(
        "eden.playground.service.make_playground_handler",
        new=lambda org_id: handler,
    ):
        result = await svc.run("org_c", pid, dataset_rows=rows)
    assert result["status"] == "completed"
    assert state["max_inflight"] <= 10


@pytest.mark.asyncio
async def test_run_cell_failure_is_isolated() -> None:
    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        if prompt_dict.get("user") == "bad":
            raise RuntimeError("provider down")
        return _result(prompt_dict)

    svc = PlaygroundService(memory_only=True)
    pid = await _make_playground(svc, "org_f", {"tasks": _tasks(1), "scorers": []})
    events: list[dict[str, Any]] = []

    async def on_event(evt: dict[str, Any]) -> None:
        events.append(evt)

    with patch(
        "eden.playground.service.make_playground_handler",
        new=lambda org_id: handler,
    ):
        result = await svc.run(
            "org_f",
            pid,
            dataset_rows=[
                {"id": "r0", "input": "good"},
                {"id": "r1", "input": "bad"},
                {"id": "r2", "input": "also good"},
            ],
            on_event=on_event,
        )
    assert result["status"] == "completed"
    assert result["error_count"] == 1
    by_row = {row["row_id"]: row for row in result["matrix"]}
    assert by_row["r1"]["tasks"][0]["error"] == "provider down"
    assert by_row["r0"]["tasks"][0]["response"] == "echo:good"
    assert by_row["r2"]["tasks"][0]["response"] == "echo:also good"
    error_events = [e for e in events if e["type"] == "cell" and e["status"] == "error"]
    assert len(error_events) == 1
    assert error_events[0]["error"] == "provider down"


@pytest.mark.asyncio
async def test_run_emits_start_cells_done_sequence() -> None:
    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        return _result(prompt_dict, cost=0.002)

    svc = PlaygroundService(memory_only=True)
    pid = await _make_playground(
        svc,
        "org_e",
        {"tasks": _tasks(2), "scorers": [{"type": "exact_match"}]},
    )
    events: list[dict[str, Any]] = []

    async def on_event(evt: dict[str, Any]) -> None:
        events.append(evt)

    rows = [
        {"id": "r0", "input": "alpha", "expected_output": "echo:alpha"},
        {"id": "r1", "input": "beta"},
    ]
    with patch(
        "eden.playground.service.make_playground_handler",
        new=lambda org_id: handler,
    ):
        result = await svc.run("org_e", pid, dataset_rows=rows, on_event=on_event)

    assert events[0]["type"] == "start"
    assert events[0]["cells"] == 4
    assert events[0]["run_id"] == result["run_id"]
    cell_events = [e for e in events if e["type"] == "cell"]
    assert len(cell_events) == 4
    assert {(e["task_id"], e["row_index"]) for e in cell_events} == {
        ("task_0", 0),
        ("task_1", 0),
        ("task_0", 1),
        ("task_1", 1),
    }
    for e in cell_events:
        assert e["status"] == "ok"
        assert e["output"].startswith("echo:")
        assert e["cost_usd"] == 0.002
    # Row 0 has an expected value → real score; row 1 has none → null.
    assert all(e["score"] == 1.0 for e in cell_events if e["row_index"] == 0)
    assert all(e["score"] is None for e in cell_events if e["row_index"] == 1)
    assert events[-1]["type"] == "done"
    assert events[-1]["run_id"] == result["run_id"]
    assert events[-1]["totals"] == {"cost_usd": 0.008, "cells": 4, "errors": 0}
    assert result["cost_usd"] == 0.008


@pytest.mark.asyncio
async def test_run_scores_recorded_per_cell_with_null_for_missing_expected() -> None:
    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        return _result(prompt_dict)

    svc = PlaygroundService(memory_only=True)
    pid = await _make_playground(
        svc,
        "org_s",
        {"tasks": _tasks(1), "scorers": [{"type": "exact_match"}, {"type": "json_valid"}]},
    )
    with patch(
        "eden.playground.service.make_playground_handler",
        new=lambda org_id: handler,
    ):
        result = await svc.run(
            "org_s", pid, dataset_rows=[{"id": "r0", "input": "x"}]
        )
    scores = result["matrix"][0]["tasks"][0]["scores"]
    by_name = {s["name"]: s for s in scores}
    assert by_name["exact_match"]["score"] is None
    assert "missing" in by_name["exact_match"]["detail"]
    assert by_name["json_valid"]["score"] == 0.0  # "echo:x" is not JSON


@pytest.mark.asyncio
async def test_run_cancellation_persists_partial_run() -> None:
    slow_started = asyncio.Event()
    release = asyncio.Event()

    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        if prompt_dict.get("user") == "slow":
            slow_started.set()
            await release.wait()
        return _result(prompt_dict)

    svc = PlaygroundService(memory_only=True)
    pid = await _make_playground(
        svc, "org_x", {"tasks": _tasks(1), "scorers": [], "concurrency": 1}
    )
    rows = [{"id": "r0", "input": "fast"}, {"id": "r1", "input": "slow"}]
    with patch(
        "eden.playground.service.make_playground_handler",
        new=lambda org_id: handler,
    ):
        run_task = asyncio.create_task(svc.run("org_x", pid, dataset_rows=rows))
        await asyncio.wait_for(slow_started.wait(), timeout=2)
        run_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run_task
    runs = svc._runs.get(pid) or []
    assert runs, "cancelled run was not persisted"
    partial = runs[-1]
    assert partial["status"] == "cancelled"
    by_row = {row["row_id"]: row for row in partial["matrix"]}
    assert by_row["r0"]["tasks"][0]["response"] == "echo:fast"
    assert by_row["r1"]["tasks"] == []


# ── scorers ─────────────────────────────────────────────────


def test_scorer_exact_match() -> None:
    [hit] = run_scorers([{"type": "exact_match"}], output="a", expected="a")
    assert hit["score"] == 1.0
    [miss] = run_scorers([{"type": "exact_match"}], output="a", expected="b")
    assert miss["score"] == 0.0
    [absent] = run_scorers([{"type": "exact_match"}], output="a", expected=None)
    assert absent["score"] is None
    assert "missing" in absent["detail"]


def test_scorer_contains_and_icontains() -> None:
    [c] = run_scorers([{"type": "contains", "value": "World"}], output="Hello World", expected=None)
    assert c["score"] == 1.0
    [c2] = run_scorers([{"type": "contains", "value": "world"}], output="Hello World", expected=None)
    assert c2["score"] == 0.0
    [i] = run_scorers([{"type": "icontains", "value": "WORLD"}], output="Hello World", expected=None)
    assert i["score"] == 1.0
    # Falls back to expected when no explicit value param.
    [f] = run_scorers([{"type": "contains"}], output="xyz", expected="y")
    assert f["score"] == 1.0
    [n] = run_scorers([{"type": "contains"}], output="xyz", expected=None)
    assert n["score"] is None


def test_scorer_regex_valid_invalid_and_missing() -> None:
    [ok] = run_scorers([{"type": "regex", "pattern": "^ok"}], output="ok then", expected=None)
    assert ok["score"] is True
    [no] = run_scorers([{"type": "regex", "pattern": "^ok"}], output="nope", expected=None)
    assert no["score"] is False
    [bad] = run_scorers([{"type": "regex", "pattern": "(unclosed"}], output="ok", expected=None)
    assert bad["score"] is None
    assert "invalid pattern" in bad["detail"]
    [missing] = run_scorers([{"type": "regex"}], output="ok", expected=None)
    assert missing["score"] is None
    assert "pattern missing" in missing["detail"]


def test_scorer_json_valid() -> None:
    [ok] = run_scorers([{"type": "json_valid"}], output='{"a": 1}', expected=None)
    assert ok["score"] == 1.0
    [bad] = run_scorers([{"type": "json_valid"}], output="not json", expected=None)
    assert bad["score"] == 0.0
    assert "invalid json" in bad["detail"]


def test_scorer_levenshtein_ratio() -> None:
    [same] = run_scorers([{"type": "levenshtein_ratio"}], output="abc", expected="abc")
    assert same["score"] == 1.0
    [close] = run_scorers([{"type": "levenshtein_ratio"}], output="abc", expected="axc")
    assert close["score"] == pytest.approx(2.0 / 3.0)
    [empty] = run_scorers([{"type": "levenshtein_ratio"}], output="", expected="")
    assert empty["score"] == 1.0
    [absent] = run_scorers([{"type": "levenshtein_ratio"}], output="abc", expected=None)
    assert absent["score"] is None


def test_scorer_unknown_type_and_legacy_name_key() -> None:
    [unknown] = run_scorers([{"type": "vibes"}], output="x", expected=None)
    assert unknown["score"] is None
    assert "unknown scorer type" in unknown["detail"]
    [legacy] = run_scorers([{"name": "exact_match"}], output="x", expected="x")
    assert legacy["score"] == 1.0


def test_aggregate_score() -> None:
    assert aggregate_score([]) is None
    assert aggregate_score([{"name": "a", "score": None}]) is None
    assert aggregate_score(
        [{"name": "a", "score": 1.0}, {"name": "b", "score": 0.0}]
    ) == 0.5
    assert aggregate_score([{"name": "r", "score": True}]) == 1.0
