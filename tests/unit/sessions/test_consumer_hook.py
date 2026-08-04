"""N12 — trace.finalized consumer → session rollup wiring.

The rollup step must (a) receive the stream payload's identifiers,
(b) bubble transient storage failures into the consumer's retry ladder,
and (c) swallow anything else so a rollup bug cannot dead-letter the
detection pipeline.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

import eden.sessions.rollup as rollup_mod
from eden.workers.trace_finalized_consumer import TraceFinalizedConsumer


@pytest.fixture
def consumer() -> TraceFinalizedConsumer:
    return TraceFinalizedConsumer()


_DATA = {
    "org_id": "org-1",
    "trace_id": "trace-1",
    "agent_id": "agent-a",
    "session_id": "sess-1",
    "user_id": "user-1",
}


async def test_payload_identifiers_reach_the_indexer(consumer) -> None:
    instance = AsyncMock()
    with patch.object(
        rollup_mod, "SessionRollupIndexer", return_value=instance
    ) as cls:
        await consumer._run_session_rollup("org-1", "trace-1", _DATA)
    cls.assert_called_once()
    instance.index_trace.assert_awaited_once_with(
        "org-1",
        "trace-1",
        session_id="sess-1",
        agent_id="agent-a",
        user_id="user-1",
    )


async def test_empty_payload_fields_become_none(consumer) -> None:
    instance = AsyncMock()
    data = {**_DATA, "session_id": "", "agent_id": "", "user_id": ""}
    with patch.object(rollup_mod, "SessionRollupIndexer", return_value=instance):
        await consumer._run_session_rollup("org-1", "trace-1", data)
    kwargs = instance.index_trace.await_args.kwargs
    assert kwargs == {"session_id": None, "agent_id": None, "user_id": None}


async def test_transient_failure_bubbles_for_retry(consumer) -> None:
    instance = AsyncMock()
    instance.index_trace.side_effect = ConnectionError("pg blip")
    with patch.object(rollup_mod, "SessionRollupIndexer", return_value=instance):
        with pytest.raises(ConnectionError):
            await consumer._run_session_rollup("org-1", "trace-1", _DATA)


async def test_non_transient_failure_is_swallowed(consumer) -> None:
    instance = AsyncMock()
    instance.index_trace.side_effect = ValueError("bug in rollup")
    with patch.object(rollup_mod, "SessionRollupIndexer", return_value=instance):
        await consumer._run_session_rollup("org-1", "trace-1", _DATA)  # no raise
