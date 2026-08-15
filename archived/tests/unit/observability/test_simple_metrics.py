"""The in-process metric registry that replaced the ``prometheus_client`` shims.

Two modules built their counters on ``prometheus_client`` behind a no-op
fallback. Both branches were silent failures: the library is not a declared
dependency, so the no-op is what usually ran; and where it *was* installed the
counters registered into its default registry, which Eden's hand-rolled
``/metrics`` never reads. Numbers were collected correctly and discarded.

These tests pin the replacement's contract — including the two properties that
matter for the exposition itself: a family registers exactly once (a second
registration would emit a second ``# HELP`` and invalidate the scrape), and
label cardinality is capped.
"""

from __future__ import annotations

import threading

import pytest

from eden.observability.simple_metrics import (
    Counter,
    Gauge,
    Summary,
    iter_families,
    reset_for_tests,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    reset_for_tests()
    yield
    reset_for_tests()


class TestCounter:
    def test_labelled_increment(self) -> None:
        c = Counter("t_counter_a", "help", labelnames=("status",))
        c.labels(status="ok").inc()
        c.labels(status="ok").inc(2)
        c.labels(status="err").inc()
        assert {tuple(lbl.items()): v for _, lbl, v in c.samples()} == {
            (("status", "err"),): 1.0,
            (("status", "ok"),): 3.0,
        }

    def test_unlabelled_increment(self) -> None:
        c = Counter("t_counter_b", "help")
        c.inc()
        c.inc(4)
        assert c.samples() == [("", {}, 5.0)]

    def test_missing_label_does_not_raise(self) -> None:
        """An accounting bug must never take down the caller's hot path."""
        c = Counter("t_counter_c", "help", labelnames=("status",))
        c.labels(wrong="x").inc()
        assert c.samples()  # recorded under a placeholder rather than raising


class TestSummary:
    def test_sum_and_count(self) -> None:
        s = Summary("t_summary_a", "help", labelnames=("step",))
        s.labels(step="tas").observe(1.5)
        s.labels(step="tas").observe(0.5)
        got = {(suffix, lbl["step"]): v for suffix, lbl, v in s.samples()}
        assert got[("_sum", "tas")] == 2.0
        assert got[("_count", "tas")] == 2.0

    def test_emits_both_suffixes_per_series(self) -> None:
        s = Summary("t_summary_b", "help")
        s.observe(3.0)
        assert sorted(x[0] for x in s.samples()) == ["_count", "_sum"]


class TestGauge:
    def test_set_replaces_rather_than_accumulates(self) -> None:
        g = Gauge("t_gauge_a", "help")
        g.set(5)
        g.set(2)
        assert g.samples() == [("", {}, 2.0)]


class TestRegistration:
    def test_family_appears_in_the_registry(self) -> None:
        c = Counter("t_registered", "help")
        assert any(f is c for f in iter_families())

    def test_names_are_unique_across_the_registry(self) -> None:
        """A duplicate family means a duplicate ``# HELP`` and a rejected scrape."""
        import eden.observability.ingestion.checkpoint_hook  # noqa: F401
        import eden.observability.quality_pipeline.worker  # noqa: F401

        names = [f.name for f in iter_families() if not f.name.startswith("t_")]
        dupes = {n for n in names if names.count(n) > 1}
        assert not dupes, f"families registered more than once: {dupes}"

    def test_importing_the_worker_twice_registers_once(self) -> None:
        import importlib

        import eden.observability.quality_pipeline.worker as w

        before = [f.name for f in iter_families()].count(
            "quality_pipeline_traces_total"
        )
        importlib.reload(w)
        after = [f.name for f in iter_families()].count("quality_pipeline_traces_total")
        assert after == before == 1, (
            "reloading the module re-registered its families; the exposition "
            "would carry two # HELP lines for one metric"
        )


class TestCardinalityCap:
    def test_distinct_label_values_are_capped(self) -> None:
        c = Counter("t_capped", "help", labelnames=("id",))
        for i in range(1000):
            c.labels(id=str(i)).inc()
        assert len(c.samples()) <= 128

    def test_counts_past_the_cap_are_not_lost(self) -> None:
        c = Counter("t_capped_total", "help", labelnames=("id",))
        for i in range(1000):
            c.labels(id=str(i)).inc()
        assert sum(v for _, _, v in c.samples()) == 1000.0


class TestConcurrency:
    def test_increments_are_atomic(self) -> None:
        c = Counter("t_concurrent", "help", labelnames=("status",))

        def worker() -> None:
            for _ in range(500):
                c.labels(status="ok").inc()

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert c.samples() == [("", {"status": "ok"}, 4000.0)]

    def test_rendering_during_writes_does_not_raise(self) -> None:
        """Iterating the live dict would raise 'changed size during iteration'."""
        c = Counter("t_render_race", "help", labelnames=("id",))
        stop = threading.Event()
        errors: list[BaseException] = []

        def writer() -> None:
            i = 0
            while not stop.is_set():
                c.labels(id=str(i % 200)).inc()
                i += 1

        def reader() -> None:
            try:
                while not stop.is_set():
                    c.samples()
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
        for t in threads:
            t.start()
        threading.Event().wait(0.3)
        stop.set()
        for t in threads:
            t.join()
        assert not errors, f"snapshot raced with writes: {errors}"
