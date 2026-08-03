"""CI gate for ``scripts/bench_observability_competitive.py``.

The script is a manually-run competitive scorecard, but the whole point of
its ``--assert-wins`` flag is to catch a *regression* in one of the
dimensions Eden currently wins or is at parity on (e.g. the force-keep miss
rate going back above 0%, or bounded capture silently stopping truncating).
Without a test wired into the normal ``pytest`` run, that gate only fires
when someone remembers to run the script by hand. These tests make the
gate part of CI: any PR that regresses a scored dimension fails here.

Kept fast (small N, no real I/O — everything the script itself already
mocks) so it belongs in the unit-test tree.
"""

from __future__ import annotations

import sys
from unittest.mock import patch

import pytest

from scripts.bench_observability_competitive import (
    COMPETITORS,
    bench_default_sampling,
    bench_force_keep_important,
    bench_home_kpi_query_shape,
    bench_ingest_batching,
    bench_sdk_wire_bytes,
    main,
    render_scorecard,
    run_all,
)


class TestIndividualDimensions:
    def test_default_sampling_reduces_effective_keep_below_full(self) -> None:
        result = bench_default_sampling(n=500)
        rate = result.raw["effective_keep_rate"]
        assert 0.0 < rate < 1.0
        assert all(v == "WIN" for v in result.verdicts.values())

    def test_force_keep_miss_rate_is_zero(self) -> None:
        """The headline correctness claim: Eden must never lose an
        error/slow/high-cost trace to the probabilistic gate. If this ever
        regresses above 0%, this is the exact bug the task's own examples
        call out as an immediate net-positive fix."""
        result = bench_force_keep_important(n=500, baseline_keep_rate=0.25)
        assert result.raw["eden_miss_rate"] == pytest.approx(0.0)
        assert all(v == "WIN" for v in result.verdicts.values())

    def test_sdk_wire_bytes_bounded_smaller_and_error_bypass_preserved(self) -> None:
        result = bench_sdk_wire_bytes()
        assert result.raw["bounded_bytes"] < result.raw["uncapped_bytes"]
        assert result.raw["error_bypass_ok"] is True
        assert all(v == "WIN" for v in result.verdicts.values())

    def test_ingest_batching_collapses_round_trips(self) -> None:
        result = bench_ingest_batching(n=10, per_call_overhead_s=0.0005)
        assert result.raw["batched_compress_calls"] == 1
        assert result.raw["serial_compress_calls"] == 10
        assert result.raw["batched_dedupe_calls"] <= 1
        assert all(v == "WIN" for v in result.verdicts.values())

    def test_home_kpi_prefers_rollup_and_falls_back_locally(self) -> None:
        result = bench_home_kpi_query_shape()
        assert result.raw["tinybird_uses_rollup"] is True
        assert result.raw["tinybird_result_ok"] is True
        assert result.raw["local_uses_live_scan"] is True
        # Deliberately not all WIN — Langfuse/LangSmith are scored PARITY
        # (see the function's docstring); only assert no LOSE crept in.
        assert all(v != "LOSE" for v in result.verdicts.values())
        assert result.verdicts["Phoenix"] == "WIN"


class TestScorecardAndCliGate:
    def test_run_all_has_no_lose_cells(self) -> None:
        results = run_all(n_sampling=500, n_force_keep=500, n_batch=10)
        losses = [
            (r.key, c) for r in results for c, v in r.verdicts.items() if v == "LOSE"
        ]
        assert losses == [], f"unexpected LOSE cell(s): {losses}"
        # Every dimension scores every named competitor.
        for r in results:
            assert set(r.verdicts) == set(COMPETITORS)

    def test_render_scorecard_is_well_formed(self) -> None:
        results = run_all(n_sampling=200, n_force_keep=200, n_batch=5)
        text = render_scorecard(results)
        assert "TOTAL:" in text
        assert "LOSE" not in text.split("TOTAL:")[-1] or "0 LOSE" in text

    def test_cli_assert_wins_exits_zero_when_no_losses(self) -> None:
        argv = [
            "bench_observability_competitive.py",
            "--assert-wins",
            "--n-sampling",
            "200",
            "--n-force-keep",
            "200",
            "--n-batch",
            "5",
        ]
        with patch.object(sys, "argv", argv):
            assert main() == 0
