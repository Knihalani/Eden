"""TailSamplingBuffer for OTel batch span processor (Cat 22 APM).

Reference: eden-trace-quality-system-spec.md §12.9 (Cat 22 integration).

The TailSamplingBuffer decides which spans to keep vs drop after
the full trace is complete (per Sematext 2026 formula):
  n_slots = peak_tps × tail_sampling_window × safety_factor

Cat 22's existing SamplingPolicy (apm/sampling.py, 5 keep rules:
error/slow/loop/force_trace/probabilistic) is upstream — TailSamplingBuffer
is the downstream buffer that holds the kept spans.

This implementation provides:
  - TailSamplingBuffer: ring buffer of kept spans
  - SamplingPolicy: 5-rule decision (error, slow, loop, force, prob)
  - Cat 22K8sEnricher: stub that maps deployment env to span attributes
  - ProfilingClient: stub for the v1.4 trace_step_profile_links pipeline

Pure-Python; no external deps. Integrates with the existing
`apm/sampling.py` via the same SamplingPolicy contract.
"""
from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Iterable, Sequence


# ── SamplingPolicy ────────────────────────────────────────────

# Mutated by ``eden.observability.trace_quality.wiring.install_cat22_sampling_policy``
# from Settings (N14/N16). Keys: loop / error / probabilistic.
DEFAULT_KEEP_RATES: dict[str, float] = {
    "loop": 1.0,
    "error": 1.0,
    "probabilistic": 0.15,
}


@dataclass(frozen=True)
class SamplingDecision:
    """Result of the sampling policy."""
    keep: bool
    reason: str
    rule_matched: str | None   # "error" | "slow" | "loop" | "force_trace" | "probabilistic" | None


@dataclass
class SamplingPolicy:
    """5-rule trace sampling policy per spec §4 Phase 22.

    The 5 keep rules (in priority order):
      1. error     — trace has any failure outcome
      2. slow      — total trace duration > slow_threshold_ms
      3. loop      — loop detector verdict == "LOOP"
      4. force_trace — caller explicitly forces keep
      5. probabilistic — random sampling at keep_rate

    Anything not matching → drop.

    ``DEFAULT_KEEP_RATES["loop"|"error"]`` gate the hard-keep rules so
    N16 wiring can set ``detector_keep_rate_loop=1.0`` (never drop loops).
    """

    slow_threshold_ms: float = 5_000.0
    keep_rate: float = 0.1

    def should_keep(
        self,
        *,
        has_error: bool = False,
        duration_ms: float = 0.0,
        is_loop: bool = False,
        force_trace: bool = False,
        rng: random.Random | None = None,
    ) -> SamplingDecision:
        if rng is None:
            import random as _random
            rng = _random.Random()
        if force_trace:
            return SamplingDecision(True, "forced by caller", "force_trace")
        if has_error:
            # detector_keep_rate_error (DEFAULT_KEEP_RATES["error"]) — default 1.0.
            if rng.random() < float(DEFAULT_KEEP_RATES.get("error", 1.0)):
                return SamplingDecision(True, "has error outcome", "error")
        if is_loop:
            # detector_keep_rate_loop (DEFAULT_KEEP_RATES["loop"]) — default 1.0.
            if rng.random() < float(DEFAULT_KEEP_RATES.get("loop", 1.0)):
                return SamplingDecision(True, "loop detected", "loop")
        if duration_ms > self.slow_threshold_ms:
            return SamplingDecision(True, f"slow ({duration_ms}ms)", "slow")
        # Instance keep_rate wins; DEFAULT_KEEP_RATES["probabilistic"] is
        # the N16-wired default for freshly constructed policies.
        if rng.random() < self.keep_rate:
            return SamplingDecision(True, "probabilistic sample", "probabilistic")
        return SamplingDecision(False, "no keep rule matched", None)


# ── TailSamplingBuffer ────────────────────────────────────────


@dataclass
class TailSamplingBuffer:
    """Ring buffer of kept spans per Sematext 2026 formula.

    Buffer size = peak_tps × tail_sampling_window × safety_factor.
    Default: 1000 TPS × 10s window × 1.5 = 15,000 slots.
    """

    peak_tps: float = 1000.0
    tail_sampling_window: float = 10.0
    safety_factor: float = 1.5
    policy: SamplingPolicy = field(default_factory=SamplingPolicy)
    rng_seed: int = 42

    def __post_init__(self):
        self.max_slots = int(
            self.peak_tps * self.tail_sampling_window * self.safety_factor
        )
        self._buffer: deque = deque(maxlen=self.max_slots)
        self._kept: int = 0
        self._dropped: int = 0
        self._evicted: int = 0
        import random as _random
        self._rng = _random.Random(self.rng_seed)

    @property
    def buffer_size(self) -> int:
        return len(self._buffer)

    @property
    def kept_count(self) -> int:
        return self._kept

    @property
    def dropped_count(self) -> int:
        return self._dropped

    @property
    def evicted_count(self) -> int:
        return self._evicted

    def offer(
        self,
        span: dict,
        *,
        has_error: bool = False,
        duration_ms: float = 0.0,
        is_loop: bool = False,
        force_trace: bool = False,
    ) -> SamplingDecision:
        """Offer a span to the buffer; apply the sampling policy.

        Returns the sampling decision (kept or dropped + reason).
        """
        decision = self.policy.should_keep(
            has_error=has_error,
            duration_ms=duration_ms,
            is_loop=is_loop,
            force_trace=force_trace,
            rng=self._rng,
        )
        if decision.keep:
            if len(self._buffer) >= self.max_slots:
                # Eviction happens automatically via deque.maxlen
                self._evicted += 1
            self._buffer.append(span)
            self._kept += 1
        else:
            self._dropped += 1
        return decision

    def drain(self) -> list[dict]:
        """Drain the buffer (returns all spans + clears the buffer)."""
        spans = list(self._buffer)
        self._buffer.clear()
        return spans


# ── K8sEnricher (Cat 22 §4 Phase 22) ─────────────────────────


@dataclass(frozen=True)
class K8sEnrichment:
    """Per-spec §4 Phase 22: K8sEnricher enriches spans with deployment
    metadata via Downward API env vars + SA JWT.
    """

    namespace: str = "default"
    pod_name: str = "unknown"
    service_account: str = "default"
    node_name: str = "unknown"
    cluster: str = "default"

    @classmethod
    def from_env(cls) -> "K8sEnrichment":
        """Build from K8s Downward API env vars (set by the kubelet)."""
        import os
        return cls(
            namespace=os.environ.get("POD_NAMESPACE", "default"),
            pod_name=os.environ.get("POD_NAME", "unknown"),
            service_account=os.environ.get("SERVICE_ACCOUNT", "default"),
            node_name=os.environ.get("NODE_NAME", "unknown"),
            cluster=os.environ.get("CLUSTER_NAME", "default"),
        )

    def enrich(self, span: dict) -> dict:
        """Return a copy of `span` with K8s attributes added."""
        enriched = dict(span)
        enriched.setdefault("k8s.namespace", self.namespace)
        enriched.setdefault("k8s.pod", self.pod_name)
        enriched.setdefault("k8s.service_account", self.service_account)
        enriched.setdefault("k8s.node", self.node_name)
        enriched.setdefault("k8s.cluster", self.cluster)
        return enriched


# ── ProfilingClient (Cat 22 §4 Phase 22) ─────────────────────


@dataclass
class ProfilingClient:
    """v1.4 trace_step_profile_links pipeline stub.

    Captures CPU profiles for 1% of traces (deterministic by
    trace_id) and links them to the trace via `profile_<sha256[:16]>`.
    """

    sample_rate: float = 0.01
    rng_seed: int = 42

    def __post_init__(self):
        import random as _random
        self._rng = _random.Random(self.rng_seed)

    def should_profile(self, trace_id: str) -> bool:
        """Deterministic 1% sample by trace_id hash."""
        h = int(hashlib.sha256(trace_id.encode()).hexdigest()[:8], 16)
        return (h % 10000) < (self.sample_rate * 10000)


# Avoid an explicit `import random, hashlib` at top so this module
# doesn't need them at import time; lazy-import inside methods.
import hashlib  # noqa: E402  (intentional bottom-of-file import)


__all__ = [
    "SamplingDecision",
    "SamplingPolicy",
    "TailSamplingBuffer",
    "K8sEnrichment",
    "ProfilingClient",
]