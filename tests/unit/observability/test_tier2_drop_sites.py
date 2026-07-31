"""Rows already taken out of a buffer must not vanish on an early return.

Three sites shared one shape: detach a batch from the structure that owns it,
then hit a guard clause that returns without putting it back.

``trace_quality/hooks._flush_once`` was the clearest case, because the *right*
behaviour was already sitting three lines below. On a client exception it did:

    for r in reversed(rows):
        _ACTION_QUEUE.push(r)

…but the two ``None`` checks above it simply ``return 0``. So whether up to
``_ACTION_QUEUE_BATCH`` (128) guardrail-action rows survived a Postgres outage
depended on *how* Postgres was unavailable — an exception preserved them, a
missing client discarded them. Neither of the discarding branches logged
anything, and one carried the comment "drop the rows to bound memory", which the
bounded queue already handles.

``bulk_typesense.flush_bulk_index`` had the same detach-then-return with an
absent client, losing 50 span docs per occurrence.

``late_span`` is a different flavour of invisible: it counted rejections into
``_late_stats``, whose only reader ``get_late_span_stats()`` has no callers
anywhere and is not on ``/metrics``. A clock-skewed client having every event
rejected produced a perfectly incremented number that nothing could read.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest

from eden.observability.drop_metrics import get_drop_metrics, reset_for_tests


@pytest.fixture(autouse=True)
def _clean() -> None:
    reset_for_tests()
    yield
    reset_for_tests()


class TestGuardrailRowsAreRequeued:
    @staticmethod
    def _seed(n: int) -> Any:
        from eden.observability.trace_quality import hooks

        hooks.reset_for_tests()
        for i in range(n):
            hooks._ACTION_QUEUE.push(
                {"tenant_id": "t", "trace_id": f"tr{i}", "action": "block"}
            )
        return hooks

    @pytest.mark.asyncio
    async def test_missing_storage_layer_requeues_instead_of_dropping(self) -> None:
        """The regression: this branch discarded up to 128 rows silently."""
        hooks = self._seed(5)
        with patch.object(hooks, "_get_pg", None):
            assert await hooks._flush_once() == 0
        assert len(hooks._ACTION_QUEUE._buf) == 5, (
            "guardrail rows were dropped when the storage layer was absent"
        )

    @pytest.mark.asyncio
    async def test_none_client_requeues_instead_of_dropping(self) -> None:
        hooks = self._seed(4)

        async def _no_client() -> None:
            return None

        with patch.object(hooks, "_get_pg", _no_client):
            assert await hooks._flush_once() == 0
        assert len(hooks._ACTION_QUEUE._buf) == 4

    @pytest.mark.asyncio
    async def test_the_exception_path_still_requeues(self) -> None:
        """Parity check: the branch that was already correct must stay correct."""
        hooks = self._seed(3)

        async def _boom() -> None:
            raise RuntimeError("pool exhausted")

        with patch.object(hooks, "_get_pg", _boom):
            assert await hooks._flush_once() == 0
        assert len(hooks._ACTION_QUEUE._buf) == 3

    @pytest.mark.asyncio
    async def test_an_empty_queue_is_a_no_op(self) -> None:
        hooks = self._seed(0)
        with patch.object(hooks, "_get_pg", None):
            assert await hooks._flush_once() == 0
        assert len(hooks._ACTION_QUEUE._buf) == 0


class TestBulkSearchDocsAreRequeued:
    @pytest.mark.asyncio
    async def test_absent_client_puts_the_batch_back(self) -> None:
        from eden.observability.ingestion import bulk_typesense as mod

        mod._bulk_buffer = [{"id": f"d{i}"} for i in range(3)]
        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=None,
        ):
            assert await mod.flush_bulk_index() == 0
        assert len(mod._bulk_buffer) == 3, (
            "the detached batch was discarded when the client was absent"
        )
        mod._bulk_buffer = []

    @pytest.mark.asyncio
    async def test_a_real_failure_is_counted(self) -> None:
        """Search is secondary, so this is fidelity loss — but it must be visible."""
        from eden.observability.ingestion import bulk_typesense as mod

        class _Boom:
            async def index_many(self, batch: list[dict[str, Any]]) -> int:
                raise RuntimeError("typesense down")

        mod._bulk_buffer = [{"id": f"d{i}"} for i in range(6)]
        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=_Boom(),
        ):
            assert await mod.flush_bulk_index() == 0

        assert get_drop_metrics().get(("sink_search", "write_error"), 0.0) == 6.0
        mod._bulk_buffer = []


class TestLateSpanRejectionsAreVisible:
    def test_a_rejection_reaches_the_served_metric(self) -> None:
        """``get_late_span_stats()`` has no callers and is not on /metrics."""
        from eden.observability.ingestion.late_span import evaluate_late_span

        class _Event:
            # Older than late_span_max_age_seconds (24h default).
            timestamp = (datetime.now(UTC) - timedelta(days=3)).isoformat()
            event_id = "old-1"
            attributes: dict[str, Any] = {}

        assert evaluate_late_span(_Event()) == "reject"
        assert get_drop_metrics().get(("ingest", "quota_exceeded"), 0.0) == 1.0

    def test_a_fresh_event_records_nothing(self) -> None:
        from eden.observability.ingestion.late_span import evaluate_late_span

        class _Event:
            timestamp = datetime.now(UTC).isoformat()
            event_id = "new-1"
            attributes: dict[str, Any] = {}

        assert evaluate_late_span(_Event()) in ("ok", "late")
        assert get_drop_metrics().get(("ingest", "quota_exceeded"), 0.0) == 0.0

    def test_the_original_counter_still_works(self) -> None:
        """The in-process stat is kept; it is simply no longer the only record."""
        from eden.observability.ingestion.late_span import (
            evaluate_late_span,
            get_late_span_stats,
        )

        before = get_late_span_stats()["rejected_late"]

        class _Event:
            timestamp = (datetime.now(UTC) - timedelta(days=3)).isoformat()
            event_id = "old-2"
            attributes: dict[str, Any] = {}

        evaluate_late_span(_Event())
        assert get_late_span_stats()["rejected_late"] == before + 1.0
