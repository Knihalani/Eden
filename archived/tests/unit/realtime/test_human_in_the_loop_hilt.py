"""Regression tests for HILT approve/reject <-> get_approval key agreement.

Prior to this fix, _cmd_approve/_cmd_reject wrote decisions to a Redis
string key (`hilt:{job_id}:decision:{decision_id}`) while get_approval()
read from an entirely different hash key (`hilt:{job_id}:approvals`) that
nothing ever HSET into -- every approval/rejection was invisible to
get_approval(). cleanup() also only ever deleted the unused hash/list/rewind
keys, never the actual per-decision keys that were written, leaving them to
expire only via TTL.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


class FakeRedis:
    """Minimal in-memory async fake covering the ops HILTController uses."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.lists: dict[str, list[str]] = {}

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.store[key] = value

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def delete(self, *keys: str) -> None:
        for key in keys:
            self.store.pop(key, None)
            self.lists.pop(key, None)

    async def rpush(self, key: str, value: str) -> None:
        self.lists.setdefault(key, []).append(value)

    async def lrange(self, key: str, start: int, end: int) -> list[str]:
        return list(self.lists.get(key, []))

    async def expire(self, key: str, seconds: int) -> None:
        pass

    # Deliberately no hget/hset -- if get_approval() regresses back to the
    # hash-based read, tests must fail loudly rather than silently no-op.


def _patched_redis(fake: FakeRedis):
    return patch(
        "eden.storage.redis.get_redis_client",
        new=AsyncMock(return_value=fake),
    )


class TestApproveRejectGetApprovalAgree:
    @pytest.mark.asyncio
    async def test_approve_is_visible_to_get_approval(self) -> None:
        from eden.realtime.human_in_the_loop import HILTController

        controller = HILTController()
        fake = FakeRedis()
        job_id = "job-approve-1"
        state = await controller.get_state(job_id)

        with _patched_redis(fake):
            result = await controller._cmd_approve(
                job_id, state, {"decision_id": "step-1", "notes": "looks good"}
            )
            assert result["status"] == "ok"

            approval = await controller.get_approval(job_id, "step-1")

        assert approval is not None
        assert approval["approved"] is True
        assert approval["notes"] == "looks good"

    @pytest.mark.asyncio
    async def test_reject_is_visible_to_get_approval(self) -> None:
        from eden.realtime.human_in_the_loop import HILTController

        controller = HILTController()
        fake = FakeRedis()
        job_id = "job-reject-1"
        state = await controller.get_state(job_id)

        with _patched_redis(fake):
            result = await controller._cmd_reject(
                job_id, state, {"decision_id": "step-2", "reason": "not safe"}
            )
            assert result["status"] == "ok"

            approval = await controller.get_approval(job_id, "step-2")

        assert approval is not None
        assert approval["approved"] is False
        assert approval["reason"] == "not safe"

    @pytest.mark.asyncio
    async def test_get_approval_missing_decision_returns_none(self) -> None:
        from eden.realtime.human_in_the_loop import HILTController

        controller = HILTController()
        fake = FakeRedis()
        job_id = "job-missing-1"

        with _patched_redis(fake):
            approval = await controller.get_approval(job_id, "never-written")

        assert approval is None

    @pytest.mark.asyncio
    async def test_default_decision_id_round_trips(self) -> None:
        """payload without decision_id falls back to "default" on both sides."""
        from eden.realtime.human_in_the_loop import HILTController

        controller = HILTController()
        fake = FakeRedis()
        job_id = "job-default-1"
        state = await controller.get_state(job_id)

        with _patched_redis(fake):
            await controller._cmd_approve(job_id, state, {})
            approval = await controller.get_approval(job_id)  # default decision_id

        assert approval is not None
        assert approval["approved"] is True


class TestCleanupRemovesDecisionKeys:
    @pytest.mark.asyncio
    async def test_cleanup_deletes_written_decision_keys(self) -> None:
        from eden.realtime.human_in_the_loop import HILTController

        controller = HILTController()
        fake = FakeRedis()
        job_id = "job-cleanup-1"
        state = await controller.get_state(job_id)

        with _patched_redis(fake):
            await controller._cmd_approve(job_id, state, {"decision_id": "a"})
            await controller._cmd_reject(job_id, state, {"decision_id": "b"})

            assert fake.store.get(f"hilt:{job_id}:decision:a") is not None
            assert fake.store.get(f"hilt:{job_id}:decision:b") is not None

            await controller.cleanup(job_id)

            assert fake.store.get(f"hilt:{job_id}:decision:a") is None
            assert fake.store.get(f"hilt:{job_id}:decision:b") is None

            # get_approval() must also report nothing left after cleanup.
            assert await controller.get_approval(job_id, "a") is None
            assert await controller.get_approval(job_id, "b") is None

    @pytest.mark.asyncio
    async def test_cleanup_also_clears_injected_messages_and_rewind(self) -> None:
        from eden.realtime.human_in_the_loop import HILTController

        controller = HILTController()
        fake = FakeRedis()
        job_id = "job-cleanup-2"
        fake.lists[f"hilt:{job_id}:injected_messages"] = ["{}"]
        fake.store[f"hilt:{job_id}:rewind"] = "{}"

        with _patched_redis(fake):
            await controller.cleanup(job_id)

        assert fake.lists.get(f"hilt:{job_id}:injected_messages") is None
        assert fake.store.get(f"hilt:{job_id}:rewind") is None

    @pytest.mark.asyncio
    async def test_cleanup_with_no_decisions_written_is_a_noop_for_decisions(
        self,
    ) -> None:
        from eden.realtime.human_in_the_loop import HILTController

        controller = HILTController()
        fake = FakeRedis()
        job_id = "job-cleanup-3"
        await controller.get_state(job_id)

        with _patched_redis(fake):
            # Should not raise even though no approve/reject ever happened.
            await controller.cleanup(job_id)

        assert job_id not in controller._decision_ids
