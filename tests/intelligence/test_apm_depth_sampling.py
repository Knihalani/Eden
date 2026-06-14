"""Behavioural tests for Cat 22 v1.4.1 — tail-based sampling.

Exercises the 3 new modules in
:mod:`eden.apm_depth.sampling`:

* Sizing helpers (:func:`compute_num_traces`,
  :func:`estimate_memory_gb`)
* :class:`SamplingPolicy` rule chain (errors / slow /
  loop / force / probabilistic)
* :func:`probabilistic_verdict` determinism
* :class:`TailSamplingBuffer` bookkeeping (kept / dropped
  / evicted counters, ``num_traces`` formula)
* :class:`TailSampler` orchestrator (preview + flush
  + configure)
* Singleton accessor + :func:`get_sampling_stats`
"""

from __future__ import annotations

import pytest

# ─── Sizing helpers ────────────────────────────────────────────────


class TestSizingHelpers:
    def test_num_traces_formula(self) -> None:
        from eden.apm_depth import compute_num_traces

        # 1000 tps × 10s × 1.5 = 15,000
        assert compute_num_traces(1000, 10) == 15_000
        # 10k tps × 10s × 1.5 = 150,000
        assert compute_num_traces(10_000, 10) == 150_000
        # 100k tps × 10s × 1.5 = 1,500,000
        assert compute_num_traces(100_000, 10) == 1_500_000

    def test_num_traces_handles_bad_inputs(self) -> None:
        from eden.apm_depth import compute_num_traces

        # None / negative → 0
        assert compute_num_traces(0, 10) == 0
        assert compute_num_traces(-5, 10) == 0
        # Bad types → 0
        assert compute_num_traces("not-an-int", 10) == 0  # type: ignore[arg-type]
        # decision_wait < 1 → clamped to 1
        assert compute_num_traces(1000, 0) == 1_500  # 1000 × 1 × 1.5

    def test_estimate_memory_gb(self) -> None:
        from eden.apm_depth import estimate_memory_gb

        # 18,000 traces × 20KB / 1024^2 ≈ 0.3433 GB
        gb = estimate_memory_gb(18_000)
        assert 0.30 < gb < 0.40
        # Empty
        assert estimate_memory_gb(0) == 0.0
        assert estimate_memory_gb(-1) == 0.0


# ─── SamplingPolicy rule chain ────────────────────────────────────


class TestSamplingPolicy:
    def test_keep_if_error(self) -> None:
        from eden.apm_depth import SamplingPolicy

        policy = SamplingPolicy()
        decision = policy.evaluate(
            [{"status_code": "OK"}, {"status_code": "ERROR"}]
        )
        assert decision.verdict == "keep"
        assert decision.rule == "keep_if_error"

    def test_keep_if_slow(self) -> None:
        from eden.apm_depth import SamplingPolicy

        policy = SamplingPolicy(latency_p99_threshold_ms=500)
        decision = policy.evaluate(
            [{"duration_ms": 100}, {"duration_ms": 750}]
        )
        assert decision.verdict == "keep"
        assert decision.rule == "keep_if_slow"

    def test_drop_under_slow_threshold(self) -> None:
        from eden.apm_depth import SamplingPolicy

        policy = SamplingPolicy(latency_p99_threshold_ms=500)
        decision = policy.evaluate(
            [{"duration_ms": 100}, {"duration_ms": 200}]
        )
        # No error, no slow → probabilistic
        assert decision.verdict == "probabilistic"
        assert decision.rule == "probabilistic"

    def test_keep_if_loop_substring_in_name(self) -> None:
        from eden.apm_depth import SamplingPolicy

        policy = SamplingPolicy()
        decision = policy.evaluate(
            [{"name": "invoke_gen_ai.agent.loop_iter_3"}]
        )
        assert decision.verdict == "keep"
        assert decision.rule == "keep_if_loop"

    def test_keep_if_loop_substring_in_attribute(self) -> None:
        from eden.apm_depth import SamplingPolicy

        policy = SamplingPolicy()
        decision = policy.evaluate(
            [{"attributes": {"gen_ai.agent.loop_marker": "x"}}]
        )
        assert decision.verdict == "keep"
        assert decision.rule == "keep_if_loop"

    def test_keep_if_force_trace(self) -> None:
        from eden.apm_depth import SamplingPolicy

        policy = SamplingPolicy()
        decision = policy.evaluate(
            [{"attributes": {"x-force-trace": "true"}}]
        )
        assert decision.verdict == "keep"
        assert decision.rule == "keep_if_force_trace"

    def test_default_drop_when_probabilistic_zero(self) -> None:
        from eden.apm_depth import SamplingPolicy

        policy = SamplingPolicy(probabilistic_rate=0.0)
        decision = policy.evaluate([{"duration_ms": 50}])
        assert decision.verdict == "drop"
        assert decision.rule == "default_drop"

    def test_handles_non_dict_spans(self) -> None:
        from eden.apm_depth import SamplingPolicy

        policy = SamplingPolicy(probabilistic_rate=0.0)
        decision = policy.evaluate([None, "bad", {"duration_ms": 50}])  # type: ignore[list-item]
        assert decision.verdict == "drop"

    def test_threshold_clamped(self) -> None:
        from eden.apm_depth import SamplingPolicy

        policy = SamplingPolicy(latency_p99_threshold_ms=-100)
        assert policy.latency_p99_threshold_ms == 0
        policy = SamplingPolicy(probabilistic_rate=2.0)
        assert policy.probabilistic_rate == 1.0


# ─── Probabilistic verdict (deterministic per trace) ──────────────


class TestProbabilisticVerdict:
    def test_deterministic_per_trace(self) -> None:
        from eden.apm_depth import probabilistic_verdict

        # Same trace_id + rate → same answer
        v1 = probabilistic_verdict("trace-1", 0.5)
        v2 = probabilistic_verdict("trace-1", 0.5)
        assert v1 == v2

    def test_rate_zero(self) -> None:
        from eden.apm_depth import probabilistic_verdict

        assert probabilistic_verdict("anything", 0.0) is False

    def test_rate_one(self) -> None:
        from eden.apm_depth import probabilistic_verdict

        assert probabilistic_verdict("anything", 1.0) is True

    def test_rate_clamped(self) -> None:
        from eden.apm_depth import probabilistic_verdict

        # Bad inputs
        assert probabilistic_verdict("t", "not-a-float") is False  # type: ignore[arg-type]
        assert probabilistic_verdict("t", 2.0) is True
        assert probabilistic_verdict("t", -1.0) is False

    def test_distribution_is_roughly_uniform(self) -> None:
        from eden.apm_depth import probabilistic_verdict

        # At rate=0.5, the kept-rate should be in [0.3, 0.7]
        # over 1000 traces
        kept = sum(
            1
            for i in range(1000)
            if probabilistic_verdict(f"trace-{i}", 0.5)
        )
        assert 300 < kept < 700


# ─── TailSamplingBuffer bookkeeping ───────────────────────────────


class TestTailSamplingBuffer:
    def test_add_and_ready(self) -> None:
        from eden.apm_depth import TailSamplingBuffer

        buf = TailSamplingBuffer(num_traces=10, decision_wait_sec=0)
        buf.add("org_t", "trace-1", [{"name": "x"}], now=0.0)
        buf.add("org_t", "trace-1", [{"name": "y"}], now=0.5)
        ready = buf.ready(now=10.0)
        assert len(ready) == 1
        assert ready[0].trace_id == "trace-1"
        assert len(ready[0].spans) == 2

    def test_eviction_on_overflow(self) -> None:
        from eden.apm_depth import SamplingDecision, TailSamplingBuffer

        buf = TailSamplingBuffer(num_traces=2, decision_wait_sec=999)
        buf.add("org_t", "t1", [{}], now=0.0)
        buf.add("org_t", "t2", [{}], now=0.1)
        buf.add("org_t", "t3", [{}], now=0.2)  # evicts t1
        stats = buf.stats()
        assert stats["in_memory_traces"] == 2
        assert stats["evicted_traces"] == 1

    def test_commit_keeps_and_drops(self) -> None:
        from eden.apm_depth import (
            SamplingDecision,
            TailSamplingBuffer,
        )

        buf = TailSamplingBuffer(num_traces=10, decision_wait_sec=0)
        buf.add("org_t", "t1", [{}], now=0.0)
        ready = buf.ready(now=10.0)
        assert len(ready) == 1
        # Keep
        buf.commit(
            "t1", SamplingDecision(verdict="keep", rule="keep_if_error")
        )
        # Drop
        buf.add("org_t", "t2", [{}], now=0.0)
        buf.ready(now=10.0)
        buf.commit("t2", SamplingDecision(verdict="drop", rule="default_drop"))
        stats = buf.stats()
        assert stats["kept_traces"] == 1
        assert stats["dropped_traces"] == 1
        assert stats["in_memory_traces"] == 0

    def test_ignores_bad_trace_id(self) -> None:
        from eden.apm_depth import TailSamplingBuffer

        buf = TailSamplingBuffer(num_traces=10)
        buf.add("org_t", "", [{}])
        buf.add("org_t", None, [{}])  # type: ignore[arg-type]
        assert buf.stats()["in_memory_traces"] == 0

    def test_clear(self) -> None:
        from eden.apm_depth import (
            SamplingDecision,
            TailSamplingBuffer,
        )

        buf = TailSamplingBuffer(num_traces=10)
        buf.add("org_t", "t1", [{}])
        buf.commit(
            "t1", SamplingDecision(verdict="keep", rule="keep_if_error")
        )
        buf.clear()
        stats = buf.stats()
        assert stats["in_memory_traces"] == 0
        assert stats["kept_traces"] == 0
        assert stats["dropped_traces"] == 0
        assert stats["evicted_traces"] == 0


# ─── TailSampler orchestrator ─────────────────────────────────────


class TestTailSampler:
    def test_evaluate_single_keeps_error(self) -> None:
        from eden.apm_depth import TailSampler

        sampler = TailSampler()
        r = sampler.evaluate_single(
            "org_t",
            trace_id="trace-1",
            spans=[{"status_code": "ERROR"}],
        )
        assert r["data"]["verdict"] == "keep"
        assert r["data"]["rule"] == "keep_if_error"

    def test_evaluate_single_drops_healthy_at_zero(self) -> None:
        from eden.apm_depth import TailSampler

        sampler = TailSampler(
            policy=__import__(
                "eden.apm_depth", fromlist=["SamplingPolicy"]
            ).SamplingPolicy(probabilistic_rate=0.0)
        )
        r = sampler.evaluate_single(
            "org_t",
            trace_id="trace-1",
            spans=[{"duration_ms": 50}],
        )
        assert r["data"]["verdict"] == "drop"
        assert r["data"]["rule"] == "default_drop"

    async def test_flush_processes_ready_traces(self) -> None:
        from eden.apm_depth import TailSampler

        sampler = TailSampler()
        # Add a trace with an error span (always kept)
        sampler.submit(
            "org_t",
            "trace-1",
            [{"status_code": "ERROR", "duration_ms": 100}],
        )
        # Manually expire the wait window
        sampler.buffer._slots["trace-1"].decision_at = 0.0  # type: ignore[attr-defined]
        r = await sampler.flush()
        d = r["data"]
        assert d["evaluated"] == 1
        assert d["kept"] == 1
        assert d["dropped"] == 0

    async def test_flush_drops_when_probabilistic_fails(self) -> None:
        from eden.apm_depth import (
            SamplingPolicy,
            TailSampler,
        )

        sampler = TailSampler(policy=SamplingPolicy(probabilistic_rate=0.0))
        sampler.submit("org_t", "trace-1", [{"duration_ms": 50}])
        sampler.buffer._slots["trace-1"].decision_at = 0.0  # type: ignore[attr-defined]
        r = await sampler.flush()
        assert r["data"]["dropped"] == 1
        assert r["data"]["kept"] == 0

    def test_configure(self) -> None:
        from eden.apm_depth import TailSampler

        sampler = TailSampler()
        r = sampler.configure(
            latency_p99_threshold_ms=200, probabilistic_rate=0.05
        )
        assert r["data"]["latency_p99_threshold_ms"] == 200
        assert r["data"]["probabilistic_rate"] == 0.05


# ─── Singleton + stats ────────────────────────────────────────────


class TestSingleton:
    def test_get_singleton(self) -> None:
        from eden.apm_depth import get_tail_sampler, reset_tail_sampler

        reset_tail_sampler()
        s1 = get_tail_sampler()
        s2 = get_tail_sampler()
        assert s1 is s2
        reset_tail_sampler()

    def test_get_sampling_stats_envelope(self) -> None:
        from eden.apm_depth import get_sampling_stats, reset_tail_sampler

        reset_tail_sampler()
        r = get_sampling_stats()
        assert r["status"] == "ok"
        assert "kept_traces" in r["data"]
        assert "dropped_traces" in r["data"]
        assert "drop_rate" in r["data"]
        assert "memory_gb_estimate" in r["data"]
        reset_tail_sampler()
