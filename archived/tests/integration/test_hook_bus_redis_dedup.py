"""HookBus cross-pod Redis dedup integration tests.

Verifies that two independent :class:`HookBus` instances sharing a
Redis backend deduplicate identical events within the dedup window.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.llmops.hooks_bus import HookBus, HookEvent, _claim_redis_dedup, _DedupKey


class _FakeRedisDedup:
    """Minimal Redis fake for SET NX + GET used by HookBus dedup."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def set(
        self,
        key: str,
        value: str,
        *,
        nx: bool = False,
        ex: int | None = None,  # noqa: ARG002
    ) -> bool | None:
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def get(self, key: str) -> str | None:
        return self.store.get(key)


def _event(**kwargs) -> HookEvent:
    defaults = {
        "reason": "low_user_satisfaction",
        "severity": "medium",
        "org_id": "org-redis-dedup",
        "source": {"primary_entity_id": "feat-checkout"},
        "dedup_window_seconds": 300,
    }
    defaults.update(kwargs)
    return HookEvent(**defaults)


@pytest.mark.asyncio
async def test_redis_dedup_claim_blocks_second_emitter() -> None:
    """Second claim on the same dedup key returns None."""
    fake = _FakeRedisDedup()
    key = _DedupKey(
        reason="low_user_satisfaction",
        org_id="org-1",
        primary_entity_id="ent-1",
        cascade_parent=None,
    )

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake),
    ):
        first = await _claim_redis_dedup(key, window_seconds=300)
        second = await _claim_redis_dedup(key, window_seconds=300)

    assert first is not None
    assert second is None
    assert len(fake.store) == 1


@pytest.mark.asyncio
async def test_two_hook_buses_share_redis_dedup_window() -> None:
    """Independent buses on the same Redis dedup identically."""
    fake = _FakeRedisDedup()
    bus_a = HookBus()
    bus_b = HookBus()
    ev = _event()

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake),
    ):
        first = await bus_a.emit(ev)
        second = await bus_b.emit(_event())

    assert first is not None
    assert second is None


@pytest.mark.asyncio
async def test_different_entities_not_redis_deduped() -> None:
    fake = _FakeRedisDedup()
    bus = HookBus()

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake),
    ):
        a = await bus.emit(_event(source={"primary_entity_id": "entity-a"}))
        b = await bus.emit(_event(source={"primary_entity_id": "entity-b"}))

    assert a is not None
    assert b is not None
    assert len(fake.store) == 2
