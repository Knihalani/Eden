"""N16 — the probabilistic fallback must sample whole *traces*, not spans.

The bug these tests pin down: the fallback drew from a per-policy
``random.Random`` once per ``decide()`` call. Two consequences, both bad.

1. Spans of one trace were decided independently. At a 15% keep rate a
   10-span trace is kept in pieces essentially always — a root with no
   children, or children with no root — which is unusable for the one
   thing a trace is for.
2. The draw was process-local state, so two API workers disagreed about
   the same span, a restart reshuffled every decision, and
   ``otel_keep_attributes`` (which calls ``decide`` a second time)
   stamped an ``eden.keep`` attribute that could contradict the answer
   the ingest path had already acted on.

Every test below fails if the fix is reverted to ``self._rng.random()``.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from eden.observability.sampling.apply import keep_signals_for_event
from eden.observability.sampling.policy import (
    IntelligenceAwareSamplingPolicy,
    KeepSignals,
    reset_untraced_decision_count,
    trace_keep_position,
    untraced_decision_count,
)


def _policy(**kw: object) -> IntelligenceAwareSamplingPolicy:
    kw.setdefault("profile", "balanced")
    return IntelligenceAwareSamplingPolicy(**kw)  # type: ignore[arg-type]


def _span(trace_id: str) -> KeepSignals:
    """A plain span: no keep signal, so it reaches the probabilistic gate."""
    return KeepSignals(trace_id=trace_id)


# ── 1. Whole traces, not pieces of them ─────────────────────────────────


def test_all_spans_of_a_trace_share_one_decision() -> None:
    """200 traces x 50 spans: never a trace that is kept only in part."""
    policy = _policy()
    split = []
    for t in range(200):
        trace_id = f"trace-{t:04d}"
        decisions = {
            policy.decide(_span(trace_id)).keep for _ in range(50)
        }
        if len(decisions) != 1:
            split.append(trace_id)

    assert not split, (
        f"{len(split)} of 200 traces were kept only partially "
        f"(first: {split[:3]}); a trace missing its root or its children "
        "cannot be read as a trace"
    )


def test_partial_traces_are_actually_possible_without_the_fix() -> None:
    """Guard the guard: at this rate a per-span draw would visibly split.

    Without this, test 1 could pass for a boring reason (e.g. a keep rate
    of 0 or 1). At keep_rate=0.5 across 50 spans, a per-span draw splits a
    trace with probability 1 - 2**-49, so 200 traces would all split.
    """
    policy = _policy(keep_rate_override=0.5)
    kept = [policy.decide(_span(f"t-{i}")).keep for i in range(200)]
    assert any(kept) and not all(kept), (
        "the sample must contain both kept and dropped traces, otherwise "
        "the per-trace agreement test proves nothing"
    )


def test_span_order_does_not_change_the_answer() -> None:
    """Interleaved spans from many traces still agree per trace.

    A per-span RNG makes the answer depend on arrival order; a hash of the
    trace id cannot.
    """
    policy = _policy()
    trace_ids = [f"mixed-{i}" for i in range(60)]
    first = {t: policy.decide(_span(t)).keep for t in trace_ids}
    for _ in range(20):
        for t in reversed(trace_ids):
            assert policy.decide(_span(t)).keep is first[t]


# ── 2. No process-local state ───────────────────────────────────────────


def test_two_independent_policies_agree() -> None:
    """Same config, separate objects — identical decisions.

    This is the two-workers case. A per-instance RNG makes the two diverge
    the moment they see different traffic.
    """
    a = _policy()
    b = _policy()
    # Warm ``a`` only, exactly as an unevenly loaded worker would be.
    for i in range(97):
        a.decide(_span(f"warmup-{i}"))

    for i in range(500):
        trace_id = f"shared-{i}"
        assert a.decide(_span(trace_id)).keep == b.decide(_span(trace_id)).keep, (
            f"two workers disagreed about {trace_id}"
        )


def test_decision_survives_a_new_process() -> None:
    """A freshly interpreted process reaches the same answers.

    ``hash()`` of a str is salted per process (PEP 456), so an
    implementation built on it would pass every other test here and fail
    this one — and in production would reshuffle the whole sampled corpus
    on each deploy.
    """
    import json
    import os
    import subprocess
    import sys

    trace_ids = [f"cross-proc-{i}" for i in range(40)]
    local = [_policy(keep_rate_override=0.37).decide(_span(t)).keep for t in trace_ids]

    script = (
        "import json, sys;"
        "from eden.observability.sampling.policy import "
        "IntelligenceAwareSamplingPolicy as P, KeepSignals as K;"
        "p = P(profile='balanced', keep_rate_override=0.37);"
        "ids = json.loads(sys.argv[1]);"
        "print(json.dumps([p.decide(K(trace_id=t)).keep for t in ids]))"
    )
    repo_root = Path(__file__).resolve().parents[3]
    proc = subprocess.run(
        [sys.executable, "-c", script, json.dumps(trace_ids)],
        capture_output=True,
        text=True,
        env={
            **os.environ,
            # A *different* hash seed, which is what a redeploy gives you.
            "PYTHONHASHSEED": "12345",
            "PYTHONPATH": str(repo_root / "src"),
        },
        cwd=str(repo_root),
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout.strip()) == local, (
        "a second process disagreed — the decision is not stable across "
        "restarts"
    )


# ── 3. The keep rate is still the keep rate ─────────────────────────────


@pytest.mark.parametrize("keep_rate", [0.01, 0.1, 0.5, 0.9])
def test_keep_rate_is_statistically_correct(keep_rate: float) -> None:
    """Determinism must not cost uniformity.

    A hash with poor distribution (e.g. ``len(trace_id) % 10``) satisfies
    "one answer per trace" perfectly and gets the rate badly wrong. 20k
    ids at p=0.5 has sd ~0.0035, so a 2% band is ~5.7 sigma — tight enough
    to catch clumping, loose enough never to flake.
    """
    n = 20_000
    policy = _policy(keep_rate_override=keep_rate)
    kept = sum(1 for i in range(n) if policy.decide(_span(f"rate-{i}")).keep)
    observed = kept / n
    assert abs(observed - keep_rate) < 0.02, (
        f"keep_rate={keep_rate} produced {observed:.4f} over {n} traces"
    )


def test_positions_are_spread_across_the_unit_interval() -> None:
    """The hash fills [0,1) evenly — checked directly, not via the gate.

    Ten equal buckets over 20k ids: each should hold ~2000. Anything that
    clumps (a truncated hash, a modulo of a small space) shows up here as
    an empty or overfull bucket even when a single keep rate happens to
    land near the target.
    """
    buckets = [0] * 10
    for i in range(20_000):
        buckets[int(trace_keep_position(f"spread-{i}") * 10)] += 1

    assert min(buckets) > 1_700, f"under-filled bucket: {buckets}"
    assert max(buckets) < 2_300, f"over-filled bucket: {buckets}"


# ── 4. The OTel attribute agrees with the ingest decision ───────────────


def test_otel_attributes_agree_with_decide_and_do_not_redraw() -> None:
    """``eden.keep`` must match what the ingest gate decided.

    ``otel_keep_attributes`` calls ``decide`` a second time. Under a
    per-span RNG that second call consumed a fresh random number, so the
    attribute Eden stamped on a span could contradict the decision it had
    already acted on for that same span. Repeating both calls interleaved
    is what makes an RNG diverge.
    """
    policy = _policy(keep_rate_override=0.5)
    disagreements = []
    for i in range(300):
        signals = _span(f"otel-{i}")
        expected = policy.decide(signals).keep
        for _ in range(4):
            attrs = policy.otel_keep_attributes(signals)
            if attrs["eden.keep"] != ("true" if expected else "false"):
                disagreements.append(signals.trace_id)
            if policy.decide(signals).keep is not expected:
                disagreements.append(signals.trace_id)

    assert not disagreements, (
        f"{len(disagreements)} attribute/decision contradictions "
        f"(first: {disagreements[:3]})"
    )


def test_otel_attributes_carry_the_probabilistic_rule() -> None:
    """A kept-by-chance span is labelled as such, not left unlabelled."""
    policy = _policy(keep_rate_override=1.0 - 1e-9)
    attrs = policy.otel_keep_attributes(_span("labelled"))
    assert attrs["eden.keep"] == "true"
    assert attrs["eden.keep_rule"] == "probabilistic"


# ── 5. Rotation ─────────────────────────────────────────────────────────


def test_a_new_rng_seed_rotates_the_kept_set() -> None:
    """``rng_seed`` salts the mapping, so it can be re-rolled deliberately.

    Two independent requirements: the kept *set* must move materially, and
    the keep *rate* must not.
    """
    trace_ids = [f"rotate-{i}" for i in range(5_000)]
    a = _policy(keep_rate_override=0.5, rng_seed=1)
    b = _policy(keep_rate_override=0.5, rng_seed=2)

    kept_a = {t for t in trace_ids if a.decide(_span(t)).keep}
    kept_b = {t for t in trace_ids if b.decide(_span(t)).keep}

    overlap = len(kept_a & kept_b) / max(len(kept_a | kept_b), 1)
    # Independent halves: expected Jaccard is 1/3. Far from 1.0 (identical)
    # and far from 0.0 (suspiciously anti-correlated).
    assert 0.2 < overlap < 0.45, f"seeds did not rotate the set (jaccard={overlap:.3f})"
    for kept in (kept_a, kept_b):
        assert abs(len(kept) / len(trace_ids) - 0.5) < 0.02


def test_same_seed_is_reproducible() -> None:
    a = _policy(keep_rate_override=0.3, rng_seed=7)
    b = _policy(keep_rate_override=0.3, rng_seed=7)
    for i in range(300):
        t = f"same-seed-{i}"
        assert a.decide(_span(t)).keep == b.decide(_span(t)).keep


# ── Untraced fallback: visible, not silent ──────────────────────────────


def test_missing_trace_id_falls_back_and_is_counted() -> None:
    reset_untraced_decision_count()
    policy = _policy(keep_rate_override=0.5)
    for _ in range(25):
        policy.decide(KeepSignals(trace_id=""))
    assert untraced_decision_count() == 25
    reset_untraced_decision_count()


def test_untraced_fallback_is_tagged_distinctly_when_kept() -> None:
    """An untraced keep is not the same thing as a per-trace keep."""
    reset_untraced_decision_count()
    policy = _policy(keep_rate_override=1.0 - 1e-9)
    assert policy.decide(_span("has-a-trace")).rule_matched == "probabilistic"
    assert (
        policy.decide(KeepSignals(trace_id="")).rule_matched
        == "probabilistic_untraced"
    )
    reset_untraced_decision_count()


def test_traced_decisions_do_not_touch_the_untraced_counter() -> None:
    reset_untraced_decision_count()
    policy = _policy()
    for i in range(50):
        policy.decide(_span(f"counted-{i}"))
    assert untraced_decision_count() == 0


def test_whitespace_only_trace_id_is_treated_as_missing() -> None:
    reset_untraced_decision_count()
    _policy().decide(KeepSignals(trace_id="   "))
    assert untraced_decision_count() == 1
    reset_untraced_decision_count()


# ── The signal path actually carries the trace id ───────────────────────


def test_keep_signals_for_event_populates_trace_id() -> None:
    """The gate is only per-trace if ingest passes the trace id through."""
    sig = keep_signals_for_event(
        SimpleNamespace(
            trace_id="tr-abc",
            outcome="success",
            duration_ms=1.0,
            attributes={},
        )
    )
    assert sig.trace_id == "tr-abc"


def test_keep_signals_tolerates_a_missing_trace_id() -> None:
    sig = keep_signals_for_event(
        SimpleNamespace(outcome="success", duration_ms=1.0, attributes={})
    )
    assert sig.trace_id == ""


@pytest.mark.asyncio
async def test_ingest_gate_keeps_a_whole_trace_together() -> None:
    """End to end through ``should_route_event``: no half-routed traces."""
    import eden.observability.sampling.policy as policy_mod
    from eden.observability.sampling.apply import should_route_event
    from eden.observability.sampling.policy import reset_sampling_policy
    from eden.observability.sampling.summaries import get_sampling_summary_store

    reset_sampling_policy()
    store = get_sampling_summary_store()
    store.clear()
    policy_mod._policy = _policy(keep_rate_override=0.5)
    try:
        split = []
        for t in range(60):
            trace_id = f"gate-{t}"
            routed = set()
            for span in range(8):
                routed.add(
                    await should_route_event(
                        SimpleNamespace(
                            tenant_id="org-1",
                            trace_id=trace_id,
                            span_id=f"s{span}",
                            agent_id="a",
                            outcome="success",
                            duration_ms=1,
                            metrics={},
                            attributes={},
                        )
                    )
                )
            if len(routed) != 1:
                split.append(trace_id)
        assert not split, f"traces routed only in part: {split[:3]}"
    finally:
        store.clear()
        reset_sampling_policy()


# ── Sampling stays off by default ───────────────────────────────────────


def test_default_policy_keeps_everything() -> None:
    """The hashing change must not switch sampling on.

    Constructed with no arguments the policy is ``profile='full'``, whose
    keep rate is 1.0 — the probabilistic branch is never reached.
    """
    policy = IntelligenceAwareSamplingPolicy()
    for i in range(1_000):
        assert policy.decide(_span(f"default-{i}")).keep


def test_settings_backed_policy_keeps_everything_by_default() -> None:
    """The wired-up singleton, built from real settings, keeps 100%."""
    from eden.observability.sampling.policy import (
        get_sampling_policy,
        reset_sampling_policy,
    )

    reset_sampling_policy()
    try:
        policy = get_sampling_policy()
        assert policy.keep_rate == 1.0
        for i in range(500):
            assert policy.decide(_span(f"wired-{i}")).keep
    finally:
        reset_sampling_policy()
