"""Tests for Cat 22 TailSamplingBuffer + SamplingPolicy + K8sEnricher + ProfilingClient."""
from __future__ import annotations

import pytest

from supplementaries.cat_22_apm.tail_sampling import (
    K8sEnrichment,
    ProfilingClient,
    SamplingDecision,
    SamplingPolicy,
    TailSamplingBuffer,
)


# ── SamplingPolicy tests ────────────────────────────────────


def test_policy_keeps_error():
    policy = SamplingPolicy()
    d = policy.should_keep(has_error=True)
    assert d.keep
    assert d.rule_matched == "error"


def test_policy_keeps_slow():
    policy = SamplingPolicy(slow_threshold_ms=1000)
    d = policy.should_keep(duration_ms=5000)
    assert d.keep
    assert d.rule_matched == "slow"


def test_policy_keeps_loop():
    policy = SamplingPolicy()
    d = policy.should_keep(is_loop=True)
    assert d.keep
    assert d.rule_matched == "loop"


def test_policy_force_trace_overrides():
    """force_trace wins over other rules (highest priority)."""
    policy = SamplingPolicy()
    d = policy.should_keep(force_trace=True, has_error=False, is_loop=False)
    assert d.keep
    assert d.rule_matched == "force_trace"


def test_policy_drops_normal():
    """No rule matches → drop."""
    import random
    policy = SamplingPolicy(keep_rate=0.0)
    d = policy.should_keep(rng=random.Random(42))
    assert not d.keep
    assert d.reason == "no keep rule matched"


def test_policy_priority_order():
    """error > loop > slow (per spec)."""
    policy = SamplingPolicy()
    d = policy.should_keep(has_error=True, is_loop=True, duration_ms=10000)
    assert d.rule_matched == "error"


# ── TailSamplingBuffer tests ─────────────────────────────────


def test_buffer_default_size_is_15k():
    """Per Sematext 2026: 1000 TPS × 10s × 1.5 = 15,000 slots."""
    buf = TailSamplingBuffer()
    assert buf.max_slots == 15000


def test_buffer_custom_size():
    buf = TailSamplingBuffer(peak_tps=100, tail_sampling_window=5, safety_factor=2)
    assert buf.max_slots == 1000


def test_buffer_keeps_decision():
    buf = TailSamplingBuffer()
    d = buf.offer({"trace_id": "t1", "span": "a"}, has_error=True)
    assert d.keep
    assert buf.kept_count == 1
    assert buf.dropped_count == 0
    assert buf.buffer_size == 1


def test_buffer_drops_decision():
    """A span with no matching keep rule is dropped."""
    buf = TailSamplingBuffer(peak_tps=10, tail_sampling_window=1, safety_factor=1.0)
    # Patch the policy to never keep (keep_rate=0.0).
    buf.policy = SamplingPolicy(keep_rate=0.0)
    d = buf.offer({"trace_id": "t1"})
    assert not d.keep
    assert buf.dropped_count == 1
    assert buf.buffer_size == 0


def test_buffer_eviction_on_overflow():
    """When buffer exceeds max_slots, oldest span is evicted."""
    buf = TailSamplingBuffer(
        peak_tps=10, tail_sampling_window=1, safety_factor=1.0,
    )  # max 10 slots
    # Force-keep 15 spans.
    for i in range(15):
        buf.offer({"trace_id": f"t{i}"}, force_trace=True)
    assert buf.buffer_size == 10
    assert buf.evicted_count == 5


def test_buffer_drain():
    buf = TailSamplingBuffer()
    for i in range(5):
        buf.offer({"trace_id": f"t{i}"}, force_trace=True)
    drained = buf.drain()
    assert len(drained) == 5
    assert buf.buffer_size == 0


# ── K8sEnrichment tests ──────────────────────────────────────


def test_k8s_enrichment_default_values():
    e = K8sEnrichment()
    assert e.namespace == "default"
    assert e.pod_name == "unknown"


def test_k8s_enrichment_from_env(monkeypatch):
    monkeypatch.setenv("POD_NAMESPACE", "production")
    monkeypatch.setenv("POD_NAME", "api-server-7d4b5c")
    monkeypatch.setenv("SERVICE_ACCOUNT", "api-server-sa")
    e = K8sEnrichment.from_env()
    assert e.namespace == "production"
    assert e.pod_name == "api-server-7d4b5c"
    assert e.service_account == "api-server-sa"


def test_k8s_enrichment_enrich_adds_attrs():
    e = K8sEnrichment(namespace="prod", pod_name="api-1")
    span = {"trace_id": "t1", "span_id": "s1"}
    enriched = e.enrich(span)
    assert enriched["k8s.namespace"] == "prod"
    assert enriched["k8s.pod"] == "api-1"
    assert enriched["trace_id"] == "t1"  # original preserved


def test_k8s_enrichment_does_not_overwrite_existing():
    """Existing k8s attrs are preserved (setdefault semantics)."""
    e = K8sEnrichment(namespace="prod", pod_name="api-1")
    span = {"trace_id": "t1", "k8s.namespace": "explicit-override"}
    enriched = e.enrich(span)
    assert enriched["k8s.namespace"] == "explicit-override"


# ── ProfilingClient tests ────────────────────────────────────


def test_profiling_client_sample_rate_default():
    pc = ProfilingClient()
    assert pc.sample_rate == 0.01


def test_profiling_client_deterministic_sample():
    """Same trace_id → same decision (deterministic by SHA-256)."""
    pc = ProfilingClient(sample_rate=0.5)
    # Hash-based decision is deterministic for the same trace_id.
    decision1 = pc.should_profile("trace-abc")
    decision2 = pc.should_profile("trace-abc")
    assert decision1 == decision2


def test_profiling_client_samples_about_1_percent():
    """Over many trace_ids, ~1% should be sampled (within statistical bounds)."""
    import random
    pc = ProfilingClient(sample_rate=0.01)
    n_sampled = sum(
        1 for i in range(10000)
        if pc.should_profile(f"trace-{i}")
    )
    # Expected: 100 (1% of 10000). Allow ±50% variance.
    assert 50 <= n_sampled <= 200, f"sampled {n_sampled}/10000 (expected ~100)"


# ── End-to-end ──────────────────────────────────────────────


def test_e2e_offer_keep_drain_enrich():
    """End-to-end: offer spans → drain → enrich with K8s attrs."""
    import os
    os.environ["POD_NAMESPACE"] = "test-ns"
    os.environ["POD_NAME"] = "test-pod"
    buf = TailSamplingBuffer()
    # Force-keep some spans.
    for i in range(3):
        buf.offer({"trace_id": f"t{i}", "span_id": f"s{i}"}, force_trace=True)
    drained = buf.drain()
    # Enrich with K8s.
    enricher = K8sEnrichment.from_env()
    enriched = [enricher.enrich(s) for s in drained]
    assert all(s["k8s.namespace"] == "test-ns" for s in enriched)
    assert all(s["k8s.pod"] == "test-pod" for s in enriched)