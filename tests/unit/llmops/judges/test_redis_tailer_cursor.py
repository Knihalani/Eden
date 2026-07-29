"""The judge tailer must score each event once, not once per poll.

``seen`` was rebuilt on every 1s poll and ``xrevrange`` always re-read the
newest 100 entries, so an event was re-judged (one LLM call) every second
for as long as it stayed in the window.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

from eden.llmops.judges.redis_tailer import RedisTailer, _id_key


def _entry(entry_id: str, event_id: str) -> tuple[bytes, dict[bytes, bytes]]:
    payload = {
        "event_id": event_id,
        "event_type": "llm.call",
        "trace_id": "trace-1",
        "payload": {"text": "hi"},
    }
    return (entry_id.encode(), {b"data": json.dumps(payload).encode()})


class FakeStream:
    """Minimal Redis stream honouring XRANGE's inclusive start."""

    def __init__(self, entries):
        self.entries = list(entries)
        self.reads = 0

    async def xrevrange(self, key, end, start, count=None):
        self.reads += 1
        out = list(reversed(self.entries))
        return out[:count] if count else out

    async def xrange(self, key, start, end, count=None):
        self.reads += 1
        lo = _id_key(start if isinstance(start, str) else start.decode())
        out = [e for e in self.entries if _id_key(e[0].decode()) >= lo]
        return out[:count] if count else out

    def append(self, entry):
        self.entries.append(entry)


def _tailer_bits():
    tailer = RedisTailer()
    registry = MagicMock()
    registry.for_event.return_value = ["judge-a"]
    runner = MagicMock()
    runner.run_for_event = AsyncMock()
    return tailer, registry, runner


async def _poll(tailer, client, registry, runner):
    """One poll of a single key, with a fresh per-poll ``seen`` set."""
    await tailer._process_key(
        client, "telemetry:t1:trace-1:events", "t1", "trace-1",
        registry, runner, set(),
    )


def test_id_key_orders_numerically_not_lexicographically() -> None:
    assert _id_key("10-0") > _id_key("9-0")
    assert _id_key("5-2") > _id_key("5-1")
    assert _id_key("garbage") == (0, 0)


async def test_an_event_is_scored_once_across_many_polls() -> None:
    tailer, registry, runner = _tailer_bits()
    client = FakeStream([_entry("1-0", "e1"), _entry("2-0", "e2")])

    for _ in range(10):
        await _poll(tailer, client, registry, runner)

    assert runner.run_for_event.await_count == 2, (
        "events were re-scored on later polls"
    )


async def test_only_new_events_are_scored_after_the_first_poll() -> None:
    tailer, registry, runner = _tailer_bits()
    client = FakeStream([_entry("1-0", "e1")])

    await _poll(tailer, client, registry, runner)
    assert runner.run_for_event.await_count == 1

    client.append(_entry("2-0", "e2"))
    await _poll(tailer, client, registry, runner)
    assert runner.run_for_event.await_count == 2

    # No new entries -> no new spend.
    await _poll(tailer, client, registry, runner)
    assert runner.run_for_event.await_count == 2


async def test_cursor_persists_across_polls() -> None:
    tailer, registry, runner = _tailer_bits()
    client = FakeStream([_entry("1-0", "e1"), _entry("7-3", "e2")])
    key = "telemetry:t1:trace-1:events"

    await _poll(tailer, client, registry, runner)
    assert tailer._cursors[key] == "7-3"

    await _poll(tailer, client, registry, runner)
    assert tailer._cursors[key] == "7-3"


async def test_malformed_entries_still_advance_the_cursor() -> None:
    """An unparseable entry must not be re-read forever."""
    tailer, registry, runner = _tailer_bits()
    bad = (b"1-0", {b"data": b"not json"})
    client = FakeStream([bad])
    key = "telemetry:t1:trace-1:events"

    await _poll(tailer, client, registry, runner)
    assert tailer._cursors[key] == "1-0"
    await _poll(tailer, client, registry, runner)
    assert runner.run_for_event.await_count == 0


async def test_first_poll_does_not_replay_a_long_backlog() -> None:
    tailer, registry, runner = _tailer_bits()
    tailer.max_events_per_poll = 5
    client = FakeStream([_entry(f"{i}-0", f"e{i}") for i in range(1, 51)])

    await _poll(tailer, client, registry, runner)
    assert runner.run_for_event.await_count == 5


def test_cursor_map_is_bounded() -> None:
    tailer = RedisTailer()
    for i in range(RedisTailer.MAX_CURSORS + 50):
        tailer._remember_cursor(f"key-{i}", "1-0")
    assert len(tailer._cursors) <= RedisTailer.MAX_CURSORS
