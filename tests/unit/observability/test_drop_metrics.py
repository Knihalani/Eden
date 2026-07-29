"""Drop accounting must be bounded, closed, and safe on the hot path.

``eden_events_dropped_total`` exists because Eden discards events in roughly
eighteen places and every one of them was silent — a dropped event and an
event that was never sent looked identical from outside.

A counter added to fix that must not become the next incident. The latency
histogram already demonstrated how: it keyed on the raw request path, so an
unauthenticated attacker looping ``GET /x/<random-uuid>`` added a permanent
row per request until the pod OOMed. These tests pin the properties that stop
this counter going the same way.
"""

from __future__ import annotations

import threading

import pytest

from eden.observability.drop_metrics import (
    REASONS,
    STAGES,
    get_drop_metrics,
    record_drop,
    reset_for_tests,
    total_drops,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    reset_for_tests()
    yield
    reset_for_tests()


class TestRecording:
    def test_records_by_stage_and_reason(self) -> None:
        record_drop("ingest", "load_shed", 3)
        record_drop("ingest", "load_shed")
        assert get_drop_metrics()[("ingest", "load_shed")] == 4.0

    def test_distinct_pairs_are_independent(self) -> None:
        record_drop("ingest", "oversize", 2)
        record_drop("sink_pg", "write_error", 7)
        snap = get_drop_metrics()
        assert snap[("ingest", "oversize")] == 2.0
        assert snap[("sink_pg", "write_error")] == 7.0

    @pytest.mark.parametrize("count", [0, -1, -100])
    def test_non_positive_counts_are_ignored(self, count: int) -> None:
        record_drop("ingest", "load_shed", count)
        assert get_drop_metrics()[("ingest", "load_shed")] == 0.0

    def test_total_sums_every_pair(self) -> None:
        record_drop("ingest", "load_shed", 2)
        record_drop("sse", "queue_full", 3)
        assert total_drops() == 5.0


class TestClosedVocabulary:
    """No user-controlled string may ever become a label value."""

    def test_unknown_stage_folds_into_unknown(self) -> None:
        record_drop("../../etc/passwd", "load_shed")
        snap = get_drop_metrics()
        assert ("unknown", "load_shed") in snap
        assert not any(s.startswith("..") for s, _ in snap)

    def test_unknown_reason_folds_into_unknown(self) -> None:
        record_drop("ingest", "some-new-reason")
        assert get_drop_metrics()[("ingest", "unknown")] == 1.0

    def test_both_unknown(self) -> None:
        record_drop("nope", "nope")
        assert get_drop_metrics()[("unknown", "unknown")] == 1.0

    def test_the_count_survives_coercion(self) -> None:
        """Folding must not lose the number — that is the whole point."""
        record_drop("bogus", "bogus", 9)
        assert total_drops() == 9.0

    def test_unknown_is_itself_in_both_vocabularies(self) -> None:
        assert "unknown" in STAGES
        assert "unknown" in REASONS

    def test_a_hostile_label_cannot_escape_the_exposition(self) -> None:
        """A quote or newline in a label would forge extra series."""
        record_drop('x",forged="1', "load_shed")
        assert all('"' not in s and "\n" not in s for s, _ in get_drop_metrics())


class TestCardinalityBound:
    def test_series_count_is_bounded_by_the_vocabularies(self) -> None:
        """Even exhaustive misuse cannot exceed the cross product."""
        for stage in list(STAGES) + [f"junk{i}" for i in range(500)]:
            for reason in list(REASONS) + [f"junk{i}" for i in range(20)]:
                record_drop(stage, reason)
        snap = get_drop_metrics()
        assert len(snap) <= len(STAGES) * len(REASONS)
        assert len(snap) <= 256

    def test_every_key_is_within_the_vocabulary(self) -> None:
        for stage in ("ingest", "junk", "sink_ch"):
            for reason in ("load_shed", "junk", "timeout"):
                record_drop(stage, reason)
        for stage, reason in get_drop_metrics():
            assert stage in STAGES
            assert reason in REASONS


class TestSeededZeros:
    def test_wired_pairs_start_at_zero_not_absent(self) -> None:
        """Absent is indistinguishable from broken instrumentation."""
        snap = get_drop_metrics()
        assert snap[("ingest", "load_shed")] == 0.0
        assert snap[("queue", "queue_full")] == 0.0

    def test_reset_restores_the_seeds(self) -> None:
        record_drop("ingest", "load_shed", 5)
        reset_for_tests()
        assert get_drop_metrics()[("ingest", "load_shed")] == 0.0


class TestThreadSafety:
    def test_concurrent_increments_do_not_lose_counts(self) -> None:
        def worker() -> None:
            for _ in range(500):
                record_drop("ingest", "load_shed")

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert get_drop_metrics()[("ingest", "load_shed")] == 4000.0

    def test_snapshot_is_a_copy(self) -> None:
        snap = get_drop_metrics()
        snap[("ingest", "load_shed")] = 999.0
        assert get_drop_metrics()[("ingest", "load_shed")] == 0.0
