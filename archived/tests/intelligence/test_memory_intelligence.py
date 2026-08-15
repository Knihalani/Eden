"""Behavioural tests for Cat 5 — Memory Intelligence.

Exercises the four real services
(:class:`MemoryAttributor`,
:class:`MemoryTimelineBuilder`,
:class:`MemoryImpactScorer`,
:class:`MemoryReweaver`) and the four routes that expose
them, plus the package-contract tests and the envelope helper
tests.

Mirrors the structure of
:mod:`tests.intelligence.test_retrieval_intelligence` and
:mod:`tests.intelligence.test_cost_intelligence`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. The
  :func:`patch_postgres` autouse fixture in
  :mod:`tests.conftest` returns an empty ``fetch()`` by
  default, which gives the services a clean "no data" path.
  Tests that need data override the mock with a side-effect
  that matches the SQL fragment the service runs.

* **Helper tests** — pure-Python tests for the tokeniser,
  normalisation, role mapping, and JSON helpers (no
  Postgres required).

* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_memory`` router mounted and
  ``get_current_user`` overridden. We hit each of the 4 Cat
  5 routes and assert the response shape.
"""

from __future__ import annotations

import importlib
import json
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Async-context-manager helper for the persistence path ─────────


@pytest.fixture
def patch_persistence_acquire(mock_postgres_client: MagicMock) -> None:
    """The :mod:`_common` persistence helpers use
    ``async with client.acquire() as conn:`` so the helpers
    can wrap a transaction around the delete-then-insert
    pattern. The plain :class:`MagicMock` from
    :func:`mock_postgres_client` doesn't support async
    context managers out of the box; this fixture wires
    ``acquire()`` and ``transaction()`` to AsyncMock-shaped
    context managers that yield the same client so the
    ``mock_postgres_client.execute.await_count`` checks
    in the tests below work end-to-end."""
    # The connection inside the ``async with`` is the same
    # mock as the outer client — so ``conn.execute()`` and
    # ``client.execute()`` both land on the AsyncMock the
    # conftest fixture installed. This keeps the test
    # assertions (``client.execute.await_count >= N``)
    # meaningful.
    conn = mock_postgres_client
    tx_cm = MagicMock()
    tx_cm.__aenter__ = AsyncMock(return_value=conn)
    tx_cm.__aexit__ = AsyncMock(return_value=None)
    conn.transaction = MagicMock(return_value=tx_cm)
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=None)
    mock_postgres_client.acquire = MagicMock(return_value=acquire_cm)


# ─── Sample row builders ─────────────────────────────────────────────


def _memory_event_row(
    *,
    event_id: str = "me-1",
    trace_id: str = "trc-1",
    span_id: str | None = None,
    event_type: str = "memory.read",
    memory_id: str = "mem-1",
    text: str = "the user prefers email",
    score: float | None = 0.42,
    timestamp: datetime | None = None,
    attributes: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One row from the ``telemetry_events`` table representing
    a ``memory.*`` event. The Cat 5 attributor reads
    ``attributes->>memory_id`` and ``attributes->>text`` so
    we put the data there."""
    if timestamp is None:
        timestamp = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)
    if attributes is None:
        attributes = {"memory_id": memory_id, "text": text}
        if score is not None:
            attributes["score"] = score
    return {
        "event_id": event_id,
        "trace_id": trace_id,
        "span_id": span_id or f"span-{event_id}",
        "event_type": event_type,
        "payload": {"memory_id": memory_id, "text": text},
        "attributes": attributes,
        "tags": [],
        "source_format": "framework",
        "timestamp": timestamp,
        "name": event_type,
        "duration_ms": 5.0,
        "outcome": "success",
        "error": None,
        "parent_span_id": None,
        "agent_id": "agent-1",
        "reasoning": None,
        "tool_calls_full": None,
        "tool_results": None,
        "request_body": None,
        "response_body": {
            "text": "We will email you at your registered address."
        },
        "tenant_id": "org-test",
    }


def _timeline_row(
    *,
    memory_id: str = "mem-1",
    event_type: str = "accessed",
    actor: str = "agent:customer_service_v1",
    occurred_at: datetime | None = None,
    trace_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One row from the ``memory_timeline_events`` table."""
    if occurred_at is None:
        occurred_at = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)
    return {
        "event_type": event_type,
        "occurred_at": occurred_at,
        "actor": actor,
        "trace_id": trace_id,
        "payload_json": json.dumps(payload or {}),
        "created_at": occurred_at,
    }


def _attribution_row(
    *,
    memory_id: str = "mem-1",
    influence_score: float = 0.6,
    created_at: datetime | None = None,
) -> dict[str, Any]:
    """One row from the ``memory_attributions`` table.

    Default ``created_at`` is "now" (UTC). Older dates can be
    injected by callers for stale-data tests.
    """
    if created_at is None:
        created_at = datetime.now(UTC)
    return {
        "memory_id": memory_id,
        "influence_score": influence_score,
        "created_at": created_at,
    }


# ─── Service-level unit tests ────────────────────────────────────────


@pytest.mark.asyncio
async def test_attributor_no_memory_events_returns_ok_envelope(
    mock_postgres_client: MagicMock,
) -> None:
    """No ``memory.*`` events for the trace → "no memories
    used" envelope, ``live=True``, ``per_memory=[]``."""
    from eden.kb.episodic.memory_intel.attributor import MemoryAttributor

    # Default mock returns ``[]`` for all fetches.
    svc = MemoryAttributor()
    out = await svc.attribute("org-test", "trc-1")
    assert out["status"] == "ok"
    assert out["live"] is True
    assert out["feature"] == "memory_attributor"
    assert out["data"]["trace_id"] == "trc-1"
    assert out["data"]["per_memory"] == []
    assert out["data"]["primary_memory_id"] is None
    assert "no memories" in out["data"]["message"]


@pytest.mark.asyncio
async def test_attributor_surfaces_memories_with_overlap(
    mock_postgres_client: MagicMock,
    patch_persistence_acquire: None,
) -> None:
    """Two memories, one overlapping the answer → top-1 is the
    overlapping one, both are attributed, sum of normalised
    scores = 1.0."""
    from eden.kb.episodic.memory_intel.attributor import MemoryAttributor

    mem_event_a = _memory_event_row(
        event_id="me-1",
        memory_id="mem-A",
        text="the user prefers email communication",
    )
    # mem-B has a totally unrelated text AND no retrieval
    # score, so its raw influence is exactly 0. After the
    # softmax-with-floor normalisation the per-memory share
    # is the smallest possible.
    mem_event_b = _memory_event_row(
        event_id="me-2",
        memory_id="mem-B",
        text="user_allergy_peanuts",
        score=None,
        attributes={"memory_id": "mem-B", "text": "user_allergy_peanuts"},
    )
    answer_event = _memory_event_row(
        event_id="me-3",
        memory_id="dummy",  # not a memory event; just carries the answer
        text="dummy",
        event_type="llm.chat",  # NOT memory.* — picked up only for response body
    )
    # Patch the postgres fetch to return memory events for
    # the trace query, then the response body for the
    # follow-up call. The helper makes two distinct fetches
    # (one for events, one for response_body).
    fetch_calls = {"n": 0}

    async def _fetch(query, *args):
        fetch_calls["n"] += 1
        # Routing: the response-body query SELECTs the
        # single ``response_body`` column; the trace-events
        # query filters by ``tenant_id`` and orders by
        # ``timestamp ASC``.
        if "SELECT response_body" in query:
            return [answer_event]
        if "tenant_id" in query:
            return [mem_event_a, mem_event_b, answer_event]
        return []

    mock_postgres_client.fetch = AsyncMock(side_effect=_fetch)

    svc = MemoryAttributor()
    out = await svc.attribute("org-test", "trc-1")
    assert out["status"] == "ok"
    per = out["data"]["per_memory"]
    assert len(per) == 2
    # Scores sum to 1.0 (softmax normalisation).
    assert abs(sum(p["influence_score"] for p in per) - 1.0) < 1e-6
    # mem-A mentions "email" which the answer also uses, so
    # mem-A should be the primary.
    top = max(per, key=lambda p: p["influence_score"])
    assert top["memory_id"] == "mem-A"
    assert top["role"] == "primary"
    # The other memory has no overlap and no retrieval score
    # → smallest share, "context" role.
    other = next(p for p in per if p["memory_id"] == "mem-B")
    assert other["role"] == "context"
    # Persistence: the helper ran a DELETE + 2 INSERTs.
    assert mock_postgres_client.execute.await_count >= 3


@pytest.mark.asyncio
async def test_attributor_caps_at_max_memories(
    mock_postgres_client: MagicMock,
    patch_persistence_acquire: None,
) -> None:
    """The ``MAX_MEMORIES_PER_TRACE`` guardrail truncates the
    memory list (so the response stays bounded and the
    overlap heuristic stays cheap)."""
    from eden.kb.episodic.memory_intel.attributor import (
        MAX_MEMORIES_PER_TRACE,
        MemoryAttributor,
    )

    # Build MAX_MEMORIES_PER_TRACE + 5 memory events.
    rows = [
        _memory_event_row(
            event_id=f"me-{i}",
            memory_id=f"mem-{i}",
            text=f"memory {i} body",
        )
        for i in range(MAX_MEMORIES_PER_TRACE + 5)
    ]
    answer_event = _memory_event_row(
        event_id="ans",
        memory_id="dummy",
        text="dummy",
        event_type="llm.chat",
    )

    async def _fetch(query, *args):
        if "SELECT response_body" in query:
            return [answer_event]
        if "tenant_id" in query:
            return rows + [answer_event]
        return []

    mock_postgres_client.fetch = AsyncMock(side_effect=_fetch)

    svc = MemoryAttributor()
    out = await svc.attribute("org-test", "trc-1")
    assert out["status"] == "ok"
    assert len(out["data"]["per_memory"]) == MAX_MEMORIES_PER_TRACE


@pytest.mark.asyncio
async def test_attributor_persists_attributions(
    mock_postgres_client: MagicMock,
    patch_persistence_acquire: None,
) -> None:
    """The attributor writes one DELETE + one INSERT per
    attributed memory to ``memory_attributions``."""
    from eden.kb.episodic.memory_intel.attributor import MemoryAttributor

    mem_event = _memory_event_row(
        event_id="me-1",
        memory_id="mem-A",
        text="the user prefers email",
    )
    answer_event = _memory_event_row(
        event_id="ans",
        memory_id="dummy",
        text="dummy",
        event_type="llm.chat",
    )

    async def _fetch(query, *args):
        if "SELECT response_body" in query:
            return [answer_event]
        if "tenant_id" in query:
            return [mem_event, answer_event]
        return []

    mock_postgres_client.fetch = AsyncMock(side_effect=_fetch)

    svc = MemoryAttributor()
    await svc.attribute("org-test", "trc-1")
    # Look for the DELETE + INSERT in the captured queries.
    seen_delete = False
    seen_insert = False
    for call in mock_postgres_client.execute.await_args_list:
        sql = call.args[0]
        if "DELETE FROM memory_attributions" in sql:
            seen_delete = True
        if "INSERT INTO memory_attributions" in sql:
            seen_insert = True
    assert seen_delete, "expected DELETE on memory_attributions"
    assert seen_insert, "expected INSERT on memory_attributions"


@pytest.mark.asyncio
async def test_timeline_empty_returns_not_found(
    mock_postgres_client: MagicMock,
) -> None:
    """No rows for the memory_id → ``not_found`` envelope."""
    from eden.kb.episodic.memory_intel.attributor import MemoryTimelineBuilder

    mock_postgres_client.fetch = AsyncMock(return_value=[])
    svc = MemoryTimelineBuilder()
    out = await svc.timeline("org-test", memory_id="mem-missing")
    assert out["status"] == "not_found"
    assert out["live"] is True
    assert out["data"]["memory_id"] == "mem-missing"


@pytest.mark.asyncio
async def test_timeline_empty_memory_id_returns_bad_request(
    mock_postgres_client: MagicMock,
) -> None:
    """Empty ``memory_id`` → ``bad_request`` envelope (no DB
    roundtrip)."""
    from eden.kb.episodic.memory_intel.attributor import MemoryTimelineBuilder

    svc = MemoryTimelineBuilder()
    out = await svc.timeline("org-test", memory_id="")
    assert out["status"] == "bad_request"
    # Should not have hit the DB.
    assert mock_postgres_client.fetch.await_count == 0


@pytest.mark.asyncio
async def test_timeline_returns_events_in_decoded_form(
    mock_postgres_client: MagicMock,
) -> None:
    """Timeline rows include the decoded ``payload_json`` and
    the ``occurred_at`` ISO string."""
    from eden.kb.episodic.memory_intel.attributor import MemoryTimelineBuilder

    rows = [
        # Rows come back in DESC order (newest first), so
        # the test puts the *newer* event first.
        _timeline_row(
            event_type="accessed",
            actor="agent:cs-1",
            occurred_at=datetime(2026, 6, 10, 0, 0, 0, tzinfo=UTC),
            trace_id="trc-1",
            payload={"via": "rag"},
        ),
        _timeline_row(
            event_type="created",
            actor="user:u-1",
            occurred_at=datetime(2026, 3, 1, 0, 0, 0, tzinfo=UTC),
            payload={"source": "manual_entry"},
        ),
    ]
    mock_postgres_client.fetch = AsyncMock(return_value=rows)

    svc = MemoryTimelineBuilder()
    out = await svc.timeline("org-test", memory_id="mem-1")
    assert out["status"] == "ok"
    events = out["data"]["events"]
    assert len(events) == 2
    # Newest first (DESC by occurred_at).
    assert events[0]["event_type"] == "accessed"
    assert events[0]["trace_id"] == "trc-1"
    assert events[0]["payload"] == {"via": "rag"}
    assert events[1]["event_type"] == "created"
    # ISO timestamp.
    assert events[0]["occurred_at"].startswith("2026-06-10")


@pytest.mark.asyncio
async def test_impact_scorer_no_memories(
    mock_postgres_client: MagicMock,
) -> None:
    """No memories → "no memories used" envelope with empty
    ``per_memory``."""
    from eden.kb.episodic.memory_intel.attributor import MemoryImpactScorer

    mock_postgres_client.fetch = AsyncMock(return_value=[])
    svc = MemoryImpactScorer()
    out = await svc.score("org-test", "trc-1")
    assert out["status"] == "ok"
    assert out["data"]["per_memory"] == []
    assert out["data"]["primary_memory_id"] is None


@pytest.mark.asyncio
async def test_impact_scorer_weights_materiality(
    mock_postgres_client: MagicMock,
    patch_persistence_acquire: None,
) -> None:
    """A memory that has been attributed many times in the
    last 30 days gets a higher impact than a one-off."""
    from eden.kb.episodic.memory_intel.attributor import MemoryImpactScorer

    mem_event = _memory_event_row(
        event_id="me-1",
        memory_id="mem-A",
        text="the user prefers email",
    )
    answer_event = _memory_event_row(
        event_id="ans",
        memory_id="dummy",
        text="dummy",
        event_type="llm.chat",
    )
    # 5 prior attributions for mem-A.
    recent_rows = [
        _attribution_row(memory_id="mem-A", influence_score=0.6)
        for _ in range(5)
    ]

    async def _fetch(query, *args):
        if "SELECT response_body" in query:
            return [answer_event]
        if "memory_attributions" in query:
            return recent_rows
        if "tenant_id" in query:
            return [mem_event, answer_event]
        return []

    mock_postgres_client.fetch = AsyncMock(side_effect=_fetch)

    svc = MemoryImpactScorer()
    out = await svc.score("org-test", "trc-1")
    assert out["status"] == "ok"
    per = out["data"]["per_memory"]
    assert len(per) == 1
    # materiality = min(1.0, 5 / 10) = 0.5
    assert per[0]["materiality"] == 0.5
    # recency is at most 1.0 (the row is "now").
    assert per[0]["recency"] > 0.0
    # retrieval_score is 0.42 from the memory event.
    assert per[0]["retrieval_score"] == 0.42


@pytest.mark.asyncio
async def test_reaver_flags_stale_and_demote(
    mock_postgres_client: MagicMock,
) -> None:
    """A memory that was last accessed 100 days ago AND has
    no attributions in the last 30 days gets BOTH an
    ``archive`` and a ``demote`` suggestion."""
    from eden.kb.episodic.memory_intel.attributor import (
        STALE_DAYS,
        MemoryReweaver,
    )

    last = datetime.now(UTC) - timedelta(days=STALE_DAYS + 10)

    async def _fetch(query, *args):
        if "memory_timeline_events" in query and "MAX(occurred_at)" in query:
            return [{"last_accessed": last}]
        if "memory_attributions" in query:
            return []
        if "memory_timeline_events" in query and "DISTINCT memory_id" in query:
            return [{"memory_id": "mem-stale"}]
        return []

    mock_postgres_client.fetch = AsyncMock(side_effect=_fetch)
    svc = MemoryReweaver()
    out = await svc.suggest("org-test", memory_id="mem-stale")
    assert out["status"] == "ok"
    actions = [s["action"] for s in out["data"]["suggestions"]]
    assert "archive" in actions
    assert "demote" in actions


@pytest.mark.asyncio
async def test_reaver_flags_near_duplicate(
    mock_postgres_client: MagicMock,
) -> None:
    """A memory with a near-duplicate (> 0.85 Jaccard) in the
    org's corpus gets a ``merge`` suggestion."""
    from eden.kb.episodic.memory_intel.attributor import (
        MemoryReweaver,
    )

    # Two memories with substantial text overlap (Jaccard
    # ≥ NEAR_DUPLICATE_THRESHOLD = 0.85). The tokeniser
    # strips 1-char tokens + stopwords so we use
    # 4-token + 4-token texts with 3 shared tokens
    # → Jaccard = 3/5 = 0.6 (still too low). Bump to
    # 4 + 5 with 4 shared → 4/5 = 0.8 (still under 0.85).
    # Use identical 6-token texts → Jaccard = 1.0.
    target = "mem-1"
    other = "mem-2"
    text = "user birthday march 15 pacific timezone"

    async def _fetch(query, *args):
        if "MAX(occurred_at)" in query:
            # last accessed just now → no archive
            return [{"last_accessed": datetime.now(UTC)}]
        if "memory_attributions" in query:
            # 5 prior attributions → no demote
            return [
                {"trace_id": f"t{i}", "influence_score": 0.5,
                 "created_at": datetime.now(UTC)}
                for i in range(5)
            ]
        if "DISTINCT memory_id" in query:
            return [{"memory_id": target}]
        # Corpus for near-dup scan comes from telemetry_events
        # (not jsonb_each — see `_fetch_memories_metadata_for_org`).
        if "telemetry_events" in query and "memory_id" in query:
            return [
                {"memory_id": target, "memory_text": text},
                {"memory_id": other, "memory_text": text},
            ]
        return []

    mock_postgres_client.fetch = AsyncMock(side_effect=_fetch)
    svc = MemoryReweaver()
    out = await svc.suggest("org-test", memory_id=target)
    assert out["status"] == "ok"
    actions = [s["action"] for s in out["data"]["suggestions"]]
    assert "merge" in actions


@pytest.mark.asyncio
async def test_reaver_no_memories_returns_empty(
    mock_postgres_client: MagicMock,
) -> None:
    """Org with no memory events → empty suggestions list
    with a ``message`` hint."""
    from eden.kb.episodic.memory_intel.attributor import MemoryReweaver

    mock_postgres_client.fetch = AsyncMock(return_value=[])
    svc = MemoryReweaver()
    out = await svc.suggest("org-test", memory_id="")
    assert out["status"] == "ok"
    assert out["data"]["suggestions"] == []
    assert "no memories" in out["data"]["message"]


@pytest.mark.asyncio
async def test_reaver_bad_window_returns_bad_request(
    mock_postgres_client: MagicMock,
) -> None:
    """Malformed ``window`` → ``bad_request`` envelope, no DB
    roundtrip."""
    from eden.kb.episodic.memory_intel.attributor import MemoryReweaver

    svc = MemoryReweaver()
    out = await svc.suggest("org-test", memory_id="mem-1", window="forever")
    assert out["status"] == "bad_request"
    assert mock_postgres_client.fetch.await_count == 0


# ─── Helper tests (pure-Python, no DB) ───────────────────────────────


def test_tokenize_strips_stopwords() -> None:
    """The tokeniser drops English stopwords + 1-char tokens."""
    from eden.kb.episodic.memory_intel._common import _tokenize

    toks = _tokenize("The user prefers email and not phone")
    assert "the" not in toks
    assert "and" not in toks
    assert "not" not in toks
    assert "user" in toks
    assert "prefers" in toks
    assert "email" in toks
    assert "phone" in toks


def test_tokenize_empty_input() -> None:
    from eden.kb.episodic.memory_intel._common import _tokenize

    assert _tokenize("") == set()
    assert _tokenize(None or "") == set()


def test_token_overlap_jaccard() -> None:
    """Two sets with 50% overlap → 0.5 Jaccard."""
    from eden.kb.episodic.memory_intel._common import _token_overlap

    assert _token_overlap("apple banana cherry", "banana cherry date") == 0.5


def test_token_overlap_empty_returns_zero() -> None:
    from eden.kb.episodic.memory_intel._common import _token_overlap

    assert _token_overlap("", "answer") == 0.0
    assert _token_overlap("memory", "") == 0.0


def test_role_for_score_thresholds() -> None:
    from eden.kb.episodic.memory_intel._common import (
        _role_for_score,
    )

    assert _role_for_score(0.9) == "primary"
    assert _role_for_score(0.6) == "primary"
    assert _role_for_score(0.5) == "secondary"  # not strictly > 0.5
    assert _role_for_score(0.4) == "secondary"
    assert _role_for_score(0.2) == "secondary"
    assert _role_for_score(0.15) == "context"  # not strictly > 0.15
    assert _role_for_score(0.05) == "context"


def test_normalise_attributions_empty() -> None:
    from eden.kb.episodic.memory_intel._common import _normalise_attributions

    assert _normalise_attributions([]) == []


def test_normalise_attributions_single() -> None:
    from eden.kb.episodic.memory_intel._common import _normalise_attributions

    # A single chunk → full weight (so 1-chunk attribution
    # is meaningful, not 0.0).
    assert _normalise_attributions([0.3]) == [1.0]


def test_normalise_attributions_sums_to_one() -> None:
    from eden.kb.episodic.memory_intel._common import _normalise_attributions

    out = _normalise_attributions([0.5, 0.3, 0.2])
    assert abs(sum(out) - 1.0) < 1e-6
    # Order preserved.
    assert out[0] > out[1] > out[2]


def test_normalise_attributions_zeros_uniform() -> None:
    """All-zero scores → uniform 1/N split (so the response
    is well-formed even with no signal)."""
    from eden.kb.episodic.memory_intel._common import _normalise_attributions

    out = _normalise_attributions([0.0, 0.0, 0.0])
    assert all(abs(x - 1 / 3) < 1e-6 for x in out)


def test_safe_float_handles_non_numeric() -> None:
    from eden.kb.episodic.memory_intel._common import _safe_float

    assert _safe_float(1.5) == 1.5
    assert _safe_float(3) == 3.0
    assert _safe_float("1.0") == 0.0  # defensive
    assert _safe_float(None) == 0.0
    assert _safe_float(True) == 0.0  # bool guarded


def test_parse_window_valid() -> None:
    from eden.kb.episodic.memory_intel._common import _parse_window

    assert _parse_window("7d") == "7 days"
    assert _parse_window("24h") == "24 hours"
    assert _parse_window("30m") == "30 minutes"
    assert _parse_window("60s") == "60 seconds"
    assert _parse_window(None) == "30 days"
    assert _parse_window("") == "30 days"
    assert _parse_window("  7d  ") == "7 days"


def test_parse_window_invalid_returns_none() -> None:
    from eden.kb.episodic.memory_intel._common import _parse_window

    assert _parse_window("forever") is None
    assert _parse_window("7") is None
    assert _parse_window("7x") is None


def test_days_since_handles_naive_datetime() -> None:
    """A naive datetime (no tzinfo) is treated as UTC — the
    Postgres adapter can return naive datetimes when the
    server timezone is unset."""
    from eden.kb.episodic.memory_intel._common import _days_since

    past = datetime(2026, 6, 1, 0, 0, 0)  # naive
    days = _days_since(past)
    assert days is not None
    assert days > 0


def test_days_since_none_returns_none() -> None:
    from eden.kb.episodic.memory_intel._common import _days_since

    assert _days_since(None) is None


# ─── Package contract tests ──────────────────────────────────────────


def test_package_exports_four_classes() -> None:
    """The ``memory_intel`` package exports the 4 services."""
    from eden.kb.episodic.memory_intel import (
        MemoryAttributor,
        MemoryImpactScorer,
        MemoryReweaver,
        MemoryTimelineBuilder,
    )

    assert MemoryAttributor.name == "memory_attributor"
    assert MemoryTimelineBuilder.name == "memory_timeline"
    assert MemoryImpactScorer.name == "memory_impact"
    assert MemoryReweaver.name == "memory_reaver"


# ─── Route-level smoke tests ────────────────────────────────────────


@pytest.fixture(scope="module")
def test_app() -> FastAPI:
    """Minimal FastAPI app with the Cat 5 router mounted and
    ``get_current_user`` + the feature flag overridden."""
    from eden.api.deps import get_current_user, require_org_member, require_path_org_access
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-memory-intel-test")
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "test-user", "org_id": "org_test",
    }
    app.dependency_overrides[require_org_member] = lambda: {
        "sub": "test-user", "org_id": "org_test",
    }
    app.dependency_overrides[require_path_org_access] = lambda: "org_test"
    mod = importlib.import_module("eden.api.routes.intelligence_memory")
    if hasattr(mod, "_require_path_org"):
        app.dependency_overrides[mod._require_path_org] = lambda: "org_test"
    app.include_router(mod.router)
    return app


@pytest.fixture
def client(test_app: FastAPI) -> TestClient:
    return TestClient(test_app)


def test_route_attribute_returns_envelope(client: TestClient) -> None:
    """POST /{trace_id}/attribute → 200 + live envelope."""
    resp = client.post(
        "/orgs/org-test/intelligence/memory/trc-1/attribute",
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["live"] is True
    assert body["feature"] == "memory_attributor"


def test_route_timeline_returns_envelope(client: TestClient) -> None:
    """GET /timeline/{memory_id} → 200 + live envelope
    (no events in the mock → ``not_found``)."""
    resp = client.get(
        "/orgs/org-test/intelligence/memory/timeline/mem-1",
    )
    assert resp.status_code == 200
    body = resp.json()
    # No events in the mock → not_found.
    assert body["status"] == "not_found"
    assert body["data"]["memory_id"] == "mem-1"


def test_route_impact_returns_envelope(client: TestClient) -> None:
    """POST /{trace_id}/impact → 200 + live envelope."""
    resp = client.post(
        "/orgs/org-test/intelligence/memory/trc-1/impact",
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["feature"] == "memory_impact"


def test_route_reaver_with_memory_id(client: TestClient) -> None:
    """POST /reaver/suggest with a memory_id → 200 + envelope."""
    resp = client.post(
        "/orgs/org-test/intelligence/memory/reaver/suggest",
        json={"memory_id": "mem-1", "window": "30d"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["feature"] == "memory_reaver"


def test_route_reaver_with_no_memory_id(client: TestClient) -> None:
    """POST /reaver/suggest with empty memory_id → 200 +
    "no memories" envelope (the org has no distinct
    memory_ids in the mock)."""
    resp = client.post(
        "/orgs/org-test/intelligence/memory/reaver/suggest",
        json={"memory_id": "", "window": "30d"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["suggestions"] == []
