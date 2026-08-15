"""The performance gate must actually detect regressions.

Until now every file in ``bench/results/`` was produced by suites that call
``asyncio.sleep`` against a constant table, so the recorded numbers described
the machine's sleep resolution rather than Eden. Any claim quoted from them was
fiction, and the historical files were deleted rather than kept as a baseline.

``bench/compare.py`` is what makes the replacement numbers load-bearing. These
tests pin the three properties a gate needs to be worth having:

* it fails on a real regression;
* it does not fail on noise or on an improvement;
* it cannot be silenced by a suite quietly disappearing, or by a simulated
  suite standing in for a measured one.
"""

from __future__ import annotations

from typing import Any

import pytest

from bench.compare import compare, main


def _doc(**suites: Any) -> dict[str, Any]:
    return {"started_at": "2026-07-29T00:00:00Z", "suites": suites}


def _middleware(p50: float, name: str = "default_deny_dispatch") -> list[dict[str, Any]]:
    return [{"name": name, "n": 1000, "p50_ms": p50, "p95_ms": p50 * 1.1}]


def _compression(**kw: float) -> dict[str, Any]:
    base = {
        "compression_ratio": 15.0,
        "single_thread_ops_per_sec": 28000.0,
        "batch_compress_ops_per_sec": 42000.0,
        "batch_compress_ms": 120.0,
    }
    base.update(kw)
    return base


class TestLatencyRegressions:
    def test_slower_latency_fails(self) -> None:
        regs, _, _ = compare(
            _doc(middleware=_middleware(1.0)),
            _doc(middleware=_middleware(1.5)),
            0.20,
        )
        assert [r.key for r in regs] == [
            "middleware.default_deny_dispatch.p50_ms",
            "middleware.default_deny_dispatch.p95_ms",
        ]

    def test_faster_latency_passes(self) -> None:
        regs, _, _ = compare(
            _doc(middleware=_middleware(1.0)), _doc(middleware=_middleware(0.5)), 0.20
        )
        assert regs == []

    def test_change_within_threshold_passes(self) -> None:
        regs, _, _ = compare(
            _doc(middleware=_middleware(1.0)), _doc(middleware=_middleware(1.19)), 0.20
        )
        assert regs == []

    def test_threshold_boundary_is_exclusive(self) -> None:
        regs, _, _ = compare(
            _doc(middleware=_middleware(1.0)), _doc(middleware=_middleware(1.20)), 0.20
        )
        assert regs == []

    def test_microsecond_jitter_is_ignored(self) -> None:
        """A 20% swing on a 2µs dispatch is scheduler jitter, not a regression.

        Middleware dispatch is measured in single-digit microseconds. Without
        an absolute floor the suite would be permanently amber, and an amber
        gate gets switched off.
        """
        regs, _, _ = compare(
            _doc(middleware=_middleware(0.0020)),
            _doc(middleware=_middleware(0.0028)),
            0.20,
        )
        assert regs == []

    def test_a_real_microsecond_regression_still_fires(self) -> None:
        """The floor must not make the microsecond suite ungateable."""
        regs, _, _ = compare(
            _doc(middleware=_middleware(0.002)),
            _doc(middleware=_middleware(0.010)),
            0.20,
        )
        assert {r.key for r in regs} == {
            "middleware.default_deny_dispatch.p50_ms",
            "middleware.default_deny_dispatch.p95_ms",
        }


class TestThroughputDirection:
    """Throughput regressions are *decreases* — the opposite of latency."""

    def test_lower_throughput_fails(self) -> None:
        regs, _, _ = compare(
            _doc(compression=_compression()),
            _doc(compression=_compression(batch_compress_ops_per_sec=20000.0)),
            0.20,
        )
        assert "compression.batch_compress_ops_per_sec" in {r.key for r in regs}

    def test_higher_throughput_passes(self) -> None:
        regs, _, _ = compare(
            _doc(compression=_compression()),
            _doc(compression=_compression(batch_compress_ops_per_sec=90000.0)),
            0.20,
        )
        assert regs == []

    def test_worse_compression_ratio_fails(self) -> None:
        regs, _, _ = compare(
            _doc(compression=_compression()),
            _doc(compression=_compression(compression_ratio=5.0)),
            0.20,
        )
        assert "compression.compression_ratio" in {r.key for r in regs}

    def test_duration_field_still_reads_lower_is_better(self) -> None:
        regs, _, _ = compare(
            _doc(compression=_compression()),
            _doc(compression=_compression(batch_compress_ms=300.0)),
            0.20,
        )
        assert "compression.batch_compress_ms" in {r.key for r in regs}


class TestSimulatedSuitesAreNeverGated:
    def test_simulated_suite_is_skipped(self) -> None:
        sim = {
            "simulated": True,
            "reason": "sleeps",
            "results": [{"name": "x", "p50_ms": 1.0}],
        }
        regs, _, skipped = compare(_doc(api_latency=sim), _doc(api_latency=sim), 0.20)
        assert regs == []
        assert skipped == ["api_latency"]

    def test_a_simulated_suite_cannot_regress(self) -> None:
        """Its numbers come from a constant; a change means nothing about Eden."""
        before = {"simulated": True, "results": [{"name": "x", "p50_ms": 1.0}]}
        after = {"simulated": True, "results": [{"name": "x", "p50_ms": 100.0}]}
        regs, dropped, _ = compare(
            _doc(api_latency=before), _doc(api_latency=after), 0.20
        )
        assert regs == [] and dropped == []

    def test_dead_skipped_suite_is_not_gated(self) -> None:
        dead = {"skipped": True, "reason": "ModuleNotFoundError"}
        _, _, skipped = compare(_doc(repo_graph=dead), _doc(repo_graph=dead), 0.20)
        assert skipped == ["repo_graph"]


class TestDisappearingSuites:
    """Deleting a suite is the cheapest way to hide a regression."""

    def test_missing_metric_is_reported_as_dropped(self) -> None:
        regs, dropped, _ = compare(
            _doc(middleware=_middleware(1.0)), _doc(), 0.20
        )
        assert regs == []
        assert "middleware.default_deny_dispatch.p50_ms" in dropped

    def test_a_real_suite_replaced_by_a_simulated_one_is_dropped(self) -> None:
        """Swapping measurement for simulation must not read as 'no change'."""
        _, dropped, skipped = compare(
            _doc(middleware=_middleware(1.0)),
            _doc(middleware={"simulated": True, "results": []}),
            0.20,
        )
        assert "middleware.default_deny_dispatch.p50_ms" in dropped
        assert "middleware" in skipped


class TestCli:
    def test_exit_zero_when_clean(self, tmp_path) -> None:
        a, b = tmp_path / "a.json", tmp_path / "b.json"
        import json as _json

        a.write_text(_json.dumps(_doc(middleware=_middleware(1.0))))
        b.write_text(_json.dumps(_doc(middleware=_middleware(1.0))))
        assert main([str(a), str(b)]) == 0

    def test_exit_one_on_regression(self, tmp_path) -> None:
        import json as _json

        a, b = tmp_path / "a.json", tmp_path / "b.json"
        a.write_text(_json.dumps(_doc(middleware=_middleware(1.0))))
        b.write_text(_json.dumps(_doc(middleware=_middleware(5.0))))
        assert main([str(a), str(b)]) == 1

    def test_exit_one_when_a_suite_vanishes(self, tmp_path) -> None:
        import json as _json

        a, b = tmp_path / "a.json", tmp_path / "b.json"
        a.write_text(_json.dumps(_doc(middleware=_middleware(1.0))))
        b.write_text(_json.dumps(_doc()))
        assert main([str(a), str(b)]) == 1
        assert main([str(a), str(b), "--allow-dropped"]) == 0

    def test_rejects_a_non_bench_file(self, tmp_path) -> None:
        a, b = tmp_path / "a.json", tmp_path / "b.json"
        a.write_text('{"not": "a bench result"}')
        b.write_text('{"not": "a bench result"}')
        with pytest.raises(SystemExit):
            main([str(a), str(b)])

    def test_rejects_a_nonsense_threshold(self, tmp_path) -> None:
        import json as _json

        a, b = tmp_path / "a.json", tmp_path / "b.json"
        a.write_text(_json.dumps(_doc()))
        b.write_text(_json.dumps(_doc()))
        with pytest.raises(SystemExit):
            main([str(a), str(b), "--threshold", "20"])
