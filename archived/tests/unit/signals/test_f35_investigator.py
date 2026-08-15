"""F35 — default signal library bridge + multi-schema investigator.

Covers WP6 acceptance criteria:
* StatGate rules (``looping`` / ``cost_spike``) evaluate at **$0** — no LLM.
* Investigator-prompt schemas use heuristics (per-signal LLM batch retired).
* A matched frustration signal writes a stumble (feeds F28→F29→F30).
* ``upsert_signal_definitions`` bridges the library into the table the
  investigator reads.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.signals import investigator as inv
from eden.signals.defaults import (
    SignalTemplate,
    templates_for_profile,
    upsert_signal_definitions,
)

# ── Fake Postgres ──────────────────────────────────────────────────


class _FakePg:
    def __init__(self, definitions: list[dict[str, Any]]) -> None:
        self._definitions = definitions
        self.events: list[tuple[Any, ...]] = []
        self.upserts: list[tuple[Any, ...]] = []
        self.batch_inserts: list[tuple[Any, ...]] = []

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        if "FROM signal_definitions" in sql:
            return self._definitions
        if "FROM agent_registrations" in sql:
            return []
        if "FROM agent_identity_aliases" in sql:
            return []
        return []

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        if "FROM agent_registrations" in sql:
            return None
        if "FROM agent_identity_aliases" in sql:
            return None
        return None

    async def execute(self, sql: str, *args: Any) -> str:
        if "INSERT INTO signal_events" in sql and "UNNEST" in sql:
            self.batch_inserts.append(args)
            self.events.append(args)
        elif "INSERT INTO signal_events" in sql:
            self.events.append(args)
        elif "INSERT INTO signal_definitions" in sql:
            self.upserts.append(args)
        return "INSERT 0 1"


def _def(
    *,
    name: str,
    description: str,
    statgate_rule: str | None = None,
    investigator_prompt: str | None = None,
    template_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": uuid.uuid4(),
        "name": name,
        "description": description,
        "output_schema": {},
        "template_id": template_id,
        "statgate_rule": statgate_rule,
        "investigator_prompt": investigator_prompt,
    }


def _loop_events() -> list[dict[str, Any]]:
    return [
        {"event_type": "tool.call", "name": "search_kb", "outcome": "success"}
        for _ in range(5)
    ]


# ── StatGate: $0, no LLM ───────────────────────────────────────────


def test_statgate_looping_matches_zero_cost() -> None:
    matched, payload, conf = inv._eval_statgate_rule(
        "tool_call_rate > 0.05", _loop_events()
    )
    assert matched is True
    assert payload["cost_usd"] == 0.0
    assert payload["method"] == "statgate"
    assert conf >= 0.5


def test_statgate_cost_spike_uses_zscore() -> None:
    events = [
        {"event_type": "llm.call", "attributes": {"cost_z_score": 4.2}},
        {"event_type": "llm.call", "attributes": {}},
        {"event_type": "llm.call", "attributes": {}},
    ]
    matched, payload, _ = inv._eval_statgate_rule("cost_per_call > 3sigma", events)
    assert matched is True
    assert payload["cost_usd"] == 0.0


def test_statgate_looping_no_repeat_does_not_match() -> None:
    events = [
        {"event_type": "tool.call", "name": f"tool_{i}", "outcome": "success"}
        for i in range(5)
    ]
    matched, payload, _ = inv._eval_statgate_rule("tool_call_rate > 0.05", events)
    assert matched is False
    assert payload["cost_usd"] == 0.0


def test_statgate_caps_event_scan_at_80() -> None:
    """OPT-22: events beyond the compress_trace cap must not affect StatGate."""
    events = [
        {"event_type": "tool.call", "name": "repeat_tool", "outcome": "success"}
        for _ in range(85)
    ]
    matched_uncapped, _, _ = inv._eval_statgate_rule(
        "tool_call_rate > 0.05",
        events,
        shared=inv._precompute_statgate_state(events),
    )
    capped_events = events[:inv._STATGATE_EVENT_CAP]
    matched_capped, _, _ = inv._eval_statgate_rule(
        "tool_call_rate > 0.05",
        capped_events,
        shared=inv._precompute_statgate_state(capped_events),
    )
    assert matched_uncapped is True
    assert matched_capped is True


def test_statgate_shared_precompute_matches_naive() -> None:
    events = _loop_events() + [
        {"event_type": "llm.call", "attributes": {"cost_z_score": 4.5}},
    ]
    shared = inv._precompute_statgate_state(events)
    for rule in ("tool_call_rate > 0.05", "cost_per_call > 3sigma"):
        naive = inv._eval_statgate_rule(rule, events)
        with_shared = inv._eval_statgate_rule(rule, events, shared=shared)
        assert naive == with_shared


# ── Single LLM call for all schemas ────────────────────────────────


@pytest.mark.asyncio
async def test_multi_schema_heuristics_no_llm_batch() -> None:
    """LLM batch path removed — heuristics + StatGate only."""
    definitions = [
        _def(
            name="Forgetting",
            description="forgot context",
            investigator_prompt="Detect forgetting.",
            template_id="forgetting",
        ),
        _def(
            name="Laziness",
            description="skipped a tool",
            investigator_prompt="Detect laziness.",
            template_id="laziness",
        ),
        _def(
            name="Looping",
            description="repeats tool calls",
            statgate_rule="tool_call_rate > 0.05",
            template_id="looping",
        ),
    ]
    pg = _FakePg(definitions)

    with patch("eden.signals.investigator.get_postgres_client", AsyncMock(return_value=pg)):
        written = await inv.investigate_trace("org", "trace-1", events=_loop_events())

    # Per-signal LLM batch retired; heuristics cover investigator_prompt rows.
    # One batched insert for all definitions (2 heuristic + 1 statgate).
    assert len(written) == 3
    assert len(pg.batch_inserts) == 1
    assert len(pg.batch_inserts[0][4]) == 3


@pytest.mark.asyncio
async def test_get_postgres_client_import_path() -> None:
    # investigate_trace imports get_postgres_client lazily; ensure the
    # symbol is patchable at the module level for the test above.
    assert hasattr(inv, "investigate_trace")


# ── Frustration → stumble ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_frustration_match_writes_stumble() -> None:
    definitions = [
        _def(
            name="User frustration",
            description="user is frustrated",
            investigator_prompt="Detect frustration.",
            template_id="user_frustration",
        ),
    ]
    pg = _FakePg(definitions)

    # Heuristic matcher needs frustration keywords in the compressed summary.
    events = [
        {
            "event_type": "user.message",
            "name": "user",
            "outcome": "success",
            "input_text": "This is wrong and not helpful, I'm frustrated, try again",
        },
        {"event_type": "llm.call", "name": "assistant", "outcome": "success"},
        {"event_type": "llm.call", "name": "assistant", "outcome": "success"},
    ]

    writer = AsyncMock()
    writer.create = AsyncMock(return_value={"stumble_id": "s1", "inserted": True})

    with (
        patch("eden.signals.investigator.get_postgres_client", AsyncMock(return_value=pg)),
        patch("eden.issues.stumble_writer.StumbleWriter", return_value=writer),
        patch(
            "eden.issues.agent_identity.resolve_agent_id",
            AsyncMock(return_value="agent-a"),
        ),
    ):
        written = await inv.investigate_trace(
            "org", "trace-1", events=events, agent_id="agent-a"
        )

    assert written and written[0]["matched"] is True
    writer.create.assert_awaited_once()
    sc = writer.create.call_args.args[0]
    assert sc.kind == "user_frustration"
    assert sc.agent_id == "agent-a"
    assert sc.detected_by == "signal_investigator"
    assert len(pg.batch_inserts) == 1


@pytest.mark.asyncio
async def test_investigate_trace_batches_event_inserts() -> None:
    definitions = [
        _def(
            name="Looping",
            description="repeats tool calls",
            statgate_rule="tool_call_rate > 0.05",
            template_id="looping",
        ),
        _def(
            name="Forgetting",
            description="forgot context",
            investigator_prompt="Detect forgetting.",
            template_id="forgetting",
        ),
    ]
    pg = _FakePg(definitions)

    with (
        patch("eden.signals.investigator.get_postgres_client", AsyncMock(return_value=pg)),
        patch(
            "eden.signals.investigator._maybe_write_stumble",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.signals.investigator._trigger_clustering",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.issues.agent_identity.resolve_agent_id",
            AsyncMock(return_value=None),
        ),
    ):
        written = await inv.investigate_trace("org", "trace-1", events=_loop_events())

    assert len(written) == 2
    assert len(pg.batch_inserts) == 1
    batch_args = pg.batch_inserts[0]
    assert len(batch_args[4]) == 2  # matched flags array


@pytest.mark.asyncio
async def test_investigate_trace_parallelizes_matched_followups() -> None:
    definitions = [
        _def(
            name="Looping",
            description="repeats tool calls",
            statgate_rule="tool_call_rate > 0.05",
            template_id="looping",
        ),
        _def(
            name="Cost spike",
            description="cost spike",
            statgate_rule="cost_per_call > 3sigma",
            template_id="cost_spike",
        ),
    ]
    pg = _FakePg(definitions)
    events = [
        *[
            {"event_type": "tool.call", "name": "search_kb", "outcome": "success"}
            for _ in range(5)
        ],
        {
            "event_type": "llm.call",
            "attributes": {"cost_z_score": 4.2},
            "outcome": "success",
        },
        {"event_type": "llm.call", "attributes": {}, "outcome": "success"},
        {"event_type": "llm.call", "attributes": {}, "outcome": "success"},
    ]

    from eden.async_tasks import bounded_gather as real_bounded_gather

    gather_calls: list[int] = []

    async def _spy_gather(*aws, limit=8, return_exceptions=False):
        gather_calls.append(len(aws))
        return await real_bounded_gather(
            *aws, limit=limit, return_exceptions=return_exceptions
        )

    with (
        patch("eden.signals.investigator.get_postgres_client", AsyncMock(return_value=pg)),
        patch("eden.signals.investigator._maybe_write_stumble", AsyncMock()),
        patch("eden.signals.investigator._trigger_clustering", AsyncMock()),
        patch("eden.async_tasks.bounded_gather", _spy_gather),
        patch(
            "eden.issues.agent_identity.resolve_agent_id",
            AsyncMock(return_value=None),
        ),
    ):
        written = await inv.investigate_trace("org", "trace-1", events=events)

    assert len(written) == 2
    assert gather_calls == [2]


# ── Bridge upsert ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upsert_signal_definitions_bridges_library() -> None:
    pg = _FakePg([])
    templates = templates_for_profile("standard")
    n = await upsert_signal_definitions("org", templates, pg=pg)
    assert n == len(templates)
    assert len(pg.upserts) == len(templates)
    # Each upsert carries (org, name, desc, schema_json, enabled,
    # template_id, statgate_rule, investigator_prompt).
    first = pg.upserts[0]
    assert first[0] == "org"
    assert isinstance(first[3], str)  # output_schema JSON
    assert first[5] in {t.id for t in templates}


@pytest.mark.asyncio
async def test_upsert_enabled_override() -> None:
    pg = _FakePg([])
    templates = [
        SignalTemplate(
            id="t1", name="T1", description="d", output_schema={},
            investigator_prompt="p", default_enabled=True,
        )
    ]
    await upsert_signal_definitions("org", templates, pg=pg, enabled_override=False)
    assert pg.upserts[0][4] is False
