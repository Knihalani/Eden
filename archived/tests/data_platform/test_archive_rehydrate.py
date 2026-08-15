"""Archived traces must be readable, and must contain their message bodies.

Regression lock for the 2026-07 remediation.

Two defects made the cold archive a write-only hole:

1. ``_rehydrate_cache`` was an ``@lru_cache``-decorated function taking one
   argument, called with two to "store" a value. That raises
   ``TypeError: unhashable type: 'list'`` on every *successful* S3 fetch. The
   exception was swallowed upstream, so ``rehydrate`` returned ``[]`` and the
   trace route 404'd. An ``lru_cache`` memoises a function; it can never be a
   write-through store.
2. ``_archive_one_trace`` wrote only ``telemetry_events`` to the blob and then
   hard-deleted ``trace_messages`` — the table holding the actual prompt and
   completion text. Fixing (1) alone would have recovered span skeletons with
   dangling message hashes.

Neither was caught because the only pre-existing test exercised the
lookup-miss path, so the success path had never executed.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.services.data_platform import archive as archive_mod
from eden.services.data_platform.archive import (
    _KIND_EVENT,
    _KIND_MESSAGE,
    _REHYDRATE_CACHE_MAX,
    _rehydrate_cache_clear,
    _rehydrate_cache_get,
    _rehydrate_cache_put,
)


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    """The cache is process-global; isolate every test."""
    _rehydrate_cache_clear()
    yield
    _rehydrate_cache_clear()


class TestRehydrateCache:
    def test_put_then_get_round_trips(self) -> None:
        """The exact call that used to raise TypeError."""
        rows = [{"event_id": "e1"}, {"event_id": "e2"}]
        assert _rehydrate_cache_get("t1") is None
        _rehydrate_cache_put("t1", rows)
        assert _rehydrate_cache_get("t1") == rows

    def test_clear_drops_entries(self) -> None:
        _rehydrate_cache_put("t1", [{"event_id": "e1"}])
        _rehydrate_cache_clear()
        assert _rehydrate_cache_get("t1") is None

    def test_bounded_and_evicts_oldest_first(self) -> None:
        """A process-lifetime cache with no bound is a slow memory leak."""
        for i in range(_REHYDRATE_CACHE_MAX + 25):
            _rehydrate_cache_put(f"t{i}", [{"n": i}])

        assert len(archive_mod._rehydrate_entries) == _REHYDRATE_CACHE_MAX
        assert _rehydrate_cache_get("t0") is None, "oldest should be evicted"
        newest = f"t{_REHYDRATE_CACHE_MAX + 24}"
        assert _rehydrate_cache_get(newest) is not None

    def test_read_refreshes_lru_position(self) -> None:
        """A hot entry must not be evicted just because it was inserted early."""
        for i in range(_REHYDRATE_CACHE_MAX):
            _rehydrate_cache_put(f"t{i}", [{"n": i}])
        _rehydrate_cache_get("t0")  # touch the oldest
        _rehydrate_cache_put("overflow", [{"n": -1}])

        assert _rehydrate_cache_get("t0") is not None, "touched entry was evicted"
        assert _rehydrate_cache_get("t1") is None, "untouched oldest should go"


class _FakeService(archive_mod.ArchiveService):
    """ArchiveService with the S3 read stubbed out."""

    def __init__(self, body: str) -> None:  # noqa: D107 - test double
        self._body = body

    async def _read_impossible_cloud(self, key: str) -> str:  # type: ignore[override]
        return self._body


class TestRehydrateKindSplit:
    @pytest.mark.asyncio
    async def test_splits_events_from_messages(self) -> None:
        body = "\n".join(
            [
                f'{{"event_id": "e1", "__kind": "{_KIND_EVENT}"}}',
                f'{{"trace_id": "t1", "content": "hello",'
                f' "__kind": "{_KIND_MESSAGE}"}}',
                f'{{"event_id": "e2", "__kind": "{_KIND_EVENT}"}}',
            ]
        )
        svc = _FakeService(body)

        events = await svc._rehydrate_kind("k", _KIND_EVENT)
        messages = await svc._rehydrate_kind("k", _KIND_MESSAGE)

        assert [e["event_id"] for e in events] == ["e1", "e2"]
        assert len(messages) == 1
        assert messages[0]["content"] == "hello"

    @pytest.mark.asyncio
    async def test_discriminator_is_stripped(self) -> None:
        """Callers should see the same shape they'd read from Postgres."""
        svc = _FakeService(f'{{"event_id": "e1", "__kind": "{_KIND_EVENT}"}}')
        rows = await svc._rehydrate_kind("k", _KIND_EVENT)
        assert rows == [{"event_id": "e1"}]

    @pytest.mark.asyncio
    async def test_legacy_archive_without_discriminator_reads_as_events(
        self,
    ) -> None:
        """Blobs written before the field existed hold events only."""
        svc = _FakeService('{"event_id": "e1"}\n{"event_id": "e2"}')

        events = await svc._rehydrate_kind("k", _KIND_EVENT)
        messages = await svc._rehydrate_kind("k", _KIND_MESSAGE)

        assert len(events) == 2
        assert messages == []

    @pytest.mark.asyncio
    async def test_blank_lines_are_skipped(self) -> None:
        svc = _FakeService('{"event_id": "e1"}\n\n   \n{"event_id": "e2"}')
        assert len(await svc._rehydrate_kind("k", _KIND_EVENT)) == 2
