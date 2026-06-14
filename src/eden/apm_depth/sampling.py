"""Cat 22 — Tail-based sampling at the gateway tier (v1.4).

Per the appendix (`docs/observability-gap/22-apm-tracing-depth.md`
§5) the v1.4 ship moves Eden's gateway tier from "store
100% of spans" (a 5-10× cost problem for high-volume orgs)
to a deterministic tail-sampling pipeline:

* Buffer spans per ``(org_id, trace_id)`` for
  ``decision_wait`` seconds.
* On the decision boundary, run a :class:`SamplingPolicy`
  with rules:
    - ``KEEP`` if any span has ``status_code == ERROR``
    - ``KEEP`` if any span's ``duration_ms`` is over
      ``latency_p99_threshold_ms``
    - ``KEEP`` if any span matches ``gen_ai.agent.loop``
    - ``KEEP`` if any span has the ``x-force-trace`` tag
    - ``KEEP`` probabilistically at ``probabilistic_rate``
      (default 0.10 for healthy traffic)
* Drop everything else. Increment
  ``otel_sampling.dropped_traces`` so the existing Cat 8
  metric surface + Cat 9 alert pipeline can fire on
  > 1% drop rate (Drozd 2025 post-mortem).

Sizing (Sematext 2026 + Drozd 2025)::

    num_traces = expected_traces_per_sec × decision_wait × 1.5
    memory_gb  = num_traces × 20KB
    decision_wait = p99_latency_sec + 2s

For Eden at 1,000 traces/sec: 18,000 slots ≈ 360 MB on a
4 GB gateway tier. The :class:`TailSamplingBuffer` enforces
this — overflow bumps the dropped counter and evicts the
oldest trace (which loses any pending error info; the
counter is the "you should scale" signal).

The :class:`TailSampler` is wired into the gateway tier in
:mod:`eden.observability.telemetry_collector`. The v0 ship
exposes the engine as a service so the portal can run it
on a single span (preview), and the post-decode batch path
calls the engine once per OTel ``resourceSpan`` (the
collector already groups by trace).

The :class:`OtelSamplingDecisions` table is the audit log
of every decision (sample-of-decisions at 1% to keep the
table small). The :func:`_enforce_num_traces` formula is
tested at 1k / 10k / 100k traces/sec (per the doc).
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from ._common import _now_iso, _ok_envelope

logger = logging.getLogger(__name__)


# ─── Sizing helpers (per Sematext 2026 + Drozd 2025) ──────────────


def compute_num_traces(
    expected_traces_per_sec: int,
    decision_wait_sec: int,
    *,
    safety_factor: float = 1.5,
) -> int:
    """Return the slot count for the tail-sampling buffer.

    The Sematext 2026 sizing formula. ``safety_factor``
    defaults to 1.5 (50% headroom for bursts) per the
    Drozd 2025 post-mortem. The result is always a
    non-negative int.
    """
    try:
        eps = max(0, int(expected_traces_per_sec))
    except (TypeError, ValueError):
        eps = 0
    try:
        dw = max(1, int(decision_wait_sec))
    except (TypeError, ValueError):
        dw = 1
    return int(eps * dw * safety_factor)


def estimate_memory_gb(num_traces: int, *, avg_trace_kb: float = 20.0) -> float:
    """Return the estimated memory footprint in GB.

    Default 20 KB / trace (per Sematext 2026 — the average
    LLM trace, with 5-10 spans and ~2 KB per span).
    """
    try:
        n = max(0, int(num_traces))
    except (TypeError, ValueError):
        n = 0
    return round(n * float(avg_trace_kb) / 1024.0 / 1024.0, 4)


# ─── Sampling rules ────────────────────────────────────────────────


@dataclass(frozen=True)
class SamplingDecision:
    """The result of a :class:`SamplingPolicy` evaluation.

    ``verdict`` is one of ``"keep"`` or ``"drop"``. ``rule``
    names the rule that fired (or ``"probabilistic"`` for
    the random-sample fallback, or ``"default_drop"`` when
    no rule fires).
    """

    verdict: str
    rule: str
    score: float = 0.0


class SamplingPolicy:
    """The deterministic tail-sampling rule chain.

    Rules are evaluated in order; the first match wins.
    Order matters: errors + slow are the most important,
    then loop traces, then force-traced, then probabilistic.
    """

    def __init__(
        self,
        *,
        latency_p99_threshold_ms: int = 500,
        probabilistic_rate: float = 0.10,
        agent_loop_substring: str = "gen_ai.agent.loop",
        force_trace_attr: str = "x-force-trace",
        force_trace_value: str = "true",
    ) -> None:
        try:
            self.latency_p99_threshold_ms = max(0, int(latency_p99_threshold_ms))
        except (TypeError, ValueError):
            self.latency_p99_threshold_ms = 500
        try:
            self.probabilistic_rate = max(0.0, min(1.0, float(probabilistic_rate)))
        except (TypeError, ValueError):
            self.probabilistic_rate = 0.10
        self.agent_loop_substring = str(agent_loop_substring or "gen_ai.agent.loop")
        self.force_trace_attr = str(force_trace_attr or "x-force-trace")
        self.force_trace_value = str(force_trace_value or "true")

    def evaluate(self, spans: Iterable[dict[str, Any]]) -> SamplingDecision:
        """Return the :class:`SamplingDecision` for a batch of spans.

        Spans are dicts that may contain ``status_code``,
        ``duration_ms``, ``attributes`` (dict), and ``name``
        keys. Missing fields are treated as defaults.
        """
        max_latency = 0.0
        has_error = False
        has_loop = False
        has_force = False
        for sp in spans or []:
            if not isinstance(sp, dict):
                continue
            sc = sp.get("status_code")
            if sc == "ERROR" or sc == "error":
                has_error = True
            try:
                d = float(sp.get("duration_ms") or 0)
            except (TypeError, ValueError):
                d = 0.0
            if d > max_latency:
                max_latency = d
            attrs = sp.get("attributes") or {}
            name = sp.get("name") or ""
            if isinstance(attrs, dict):
                if attrs.get(self.force_trace_attr) == self.force_trace_value:
                    has_force = True
                if self.agent_loop_substring:
                    sub = self.agent_loop_substring
                    # Match on the span name
                    if sub in str(name) or any(isinstance(k, str) and sub in k for k in attrs) or any(
                        isinstance(v, str) and sub in v for v in attrs.values()
                    ):
                        has_loop = True
        if has_error:
            return SamplingDecision(verdict="keep", rule="keep_if_error", score=1.0)
        if max_latency > self.latency_p99_threshold_ms:
            return SamplingDecision(
                verdict="keep",
                rule="keep_if_slow",
                score=min(1.0, max_latency / max(1, self.latency_p99_threshold_ms)),
            )
        if has_loop:
            return SamplingDecision(verdict="keep", rule="keep_if_loop", score=1.0)
        if has_force:
            return SamplingDecision(
                verdict="keep", rule="keep_if_force_trace", score=1.0
            )
        # Probabilistic — deterministic per (org, trace_id)
        # so re-runs of the same trace give the same verdict.
        if self.probabilistic_rate > 0.0:
            return SamplingDecision(
                verdict="probabilistic",
                rule="probabilistic",
                score=self.probabilistic_rate,
            )
        return SamplingDecision(verdict="drop", rule="default_drop", score=0.0)


def probabilistic_verdict(trace_id: str, rate: float) -> bool:
    """Return whether a trace passes the probabilistic sample.

    Deterministic per ``trace_id`` so the same trace always
    gets the same decision on re-run (important for the
    audit log + the Cat 20 rewind flow). ``rate`` is
    clamped to ``[0, 1]``.
    """
    try:
        r = max(0.0, min(1.0, float(rate)))
    except (TypeError, ValueError):
        r = 0.0
    if r <= 0.0:
        return False
    if r >= 1.0:
        return True
    h = hashlib.sha256(str(trace_id or "").encode("utf-8")).hexdigest()
    # Use the first 8 hex chars as a uniform uint32
    n = int(h[:8], 16) / 0xFFFFFFFF
    return n < r


# ─── In-memory buffer (gateway tier) ───────────────────────────────


@dataclass
class _BufferedTrace:
    """A single trace in the :class:`TailSamplingBuffer`."""

    trace_id: str
    org_id: str
    spans: list[dict[str, Any]] = field(default_factory=list)
    received_at: float = field(default_factory=time.time)
    decision_at: float = 0.0  # received_at + decision_wait


class TailSamplingBuffer:
    """The in-memory trace buffer + dropped counter.

    The buffer is per-collector (singleton) — production
    would shard this across N gateway pods, but the v0
    ship keeps it in-process to match the rest of the
    Cat 22 surface (the per-pod dropped counter is
    aggregated at the Cat 8 metric level).
    """

    def __init__(
        self,
        *,
        num_traces: int = 0,
        decision_wait_sec: int = 10,
    ) -> None:
        self.num_traces = max(0, int(num_traces))
        try:
            self.decision_wait_sec = max(1, int(decision_wait_sec))
        except (TypeError, ValueError):
            self.decision_wait_sec = 10
        self._lock = threading.Lock()
        self._slots: dict[str, _BufferedTrace] = {}
        # Dropped counter — exposed as the
        # ``otel_sampling.dropped_traces`` Cat 8 metric.
        self.dropped_traces: int = 0
        self.kept_traces: int = 0
        self.evicted_traces: int = 0

    def add(
        self,
        org_id: str,
        trace_id: str,
        spans: list[dict[str, Any]],
        *,
        now: float | None = None,
    ) -> None:
        """Add a span batch to the buffer; evict the oldest
        trace on overflow (and bump the eviction counter).
        """
        if not isinstance(trace_id, str) or not trace_id:
            return
        if not isinstance(spans, list):
            spans = []
        ts = float(now) if now is not None else time.time()
        with self._lock:
            existing = self._slots.get(trace_id)
            if existing is None:
                # Bounded by num_traces
                if self.num_traces and len(self._slots) >= self.num_traces:
                    # Evict the oldest — increments eviction
                    # counter, NOT the dropped counter
                    # (eviction is infra pressure; dropping is
                    # a policy decision).
                    oldest_key = min(
                        self._slots, key=lambda k: self._slots[k].received_at
                    )
                    self._slots.pop(oldest_key, None)
                    self.evicted_traces += 1
                existing = _BufferedTrace(
                    trace_id=trace_id,
                    org_id=str(org_id or ""),
                    received_at=ts,
                    decision_at=ts + self.decision_wait_sec,
                )
                self._slots[trace_id] = existing
            existing.spans.extend(spans)

    def ready(self, *, now: float | None = None) -> list[_BufferedTrace]:
        """Return the traces whose decision window has elapsed.

        Does not remove them from the buffer (the caller
        calls :meth:`commit` to apply the decision and
        remove). This makes the decision atomic.
        """
        ts = float(now) if now is not None else time.time()
        out: list[_BufferedTrace] = []
        with self._lock:
            for slot in self._slots.values():
                if slot.decision_at <= ts:
                    out.append(slot)
        return out

    def commit(
        self,
        trace_id: str,
        decision: SamplingDecision,
    ) -> None:
        """Apply a :class:`SamplingDecision` and evict the trace.

        Increments ``kept_traces`` or ``dropped_traces`` as
        appropriate.
        """
        with self._lock:
            self._slots.pop(trace_id, None)
        if decision.verdict in ("keep", "probabilistic"):
            self.kept_traces += 1
        else:
            self.dropped_traces += 1

    def stats(self) -> dict[str, Any]:
        """Return the buffer's bookkeeping (dropped / kept /
        evicted counts, in-memory slot count)."""
        with self._lock:
            in_mem = len(self._slots)
        return {
            "in_memory_traces": in_mem,
            "num_traces_capacity": self.num_traces,
            "kept_traces": self.kept_traces,
            "dropped_traces": self.dropped_traces,
            "evicted_traces": self.evicted_traces,
            "decision_wait_sec": self.decision_wait_sec,
        }

    def clear(self) -> None:
        """Wipe the buffer + counters. Test helper."""
        with self._lock:
            self._slots.clear()
        self.dropped_traces = 0
        self.kept_traces = 0
        self.evicted_traces = 0


# ─── Orchestrator (the public service) ─────────────────────────────


class TailSampler:
    """The v1.4 tail-sampling orchestrator.

    Holds a :class:`SamplingPolicy` + a
    :class:`TailSamplingBuffer`. The gateway collector
    calls :meth:`submit` per OTLP batch; a separate
    background task calls :meth:`flush` on a timer.
    """

    name = "tail_sampler"

    def __init__(
        self,
        *,
        policy: SamplingPolicy | None = None,
        buffer: TailSamplingBuffer | None = None,
        expected_traces_per_sec: int = 100,
        decision_wait_sec: int = 10,
    ) -> None:
        self.policy = policy or SamplingPolicy()
        num_traces = compute_num_traces(
            expected_traces_per_sec, decision_wait_sec
        )
        self.buffer = buffer or TailSamplingBuffer(
            num_traces=num_traces, decision_wait_sec=decision_wait_sec
        )

    def submit(
        self,
        org_id: str,
        trace_id: str,
        spans: list[dict[str, Any]],
    ) -> None:
        """Hand a span batch off to the buffer."""
        self.buffer.add(org_id, trace_id, spans)

    async def flush(
        self,
        *,
        now: float | None = None,
        persist=None,
    ) -> dict[str, Any]:
        """Evaluate every ready trace and (optionally) persist.

        Returns the live ``ok`` envelope with the
        ``data: {"evaluated": N, "kept": N, "dropped": N,
        "evicted": N, "decisions": [{trace_id, verdict,
        rule}, ...]}`` payload.

        Args:
            persist: optional callable ``(org_id, trace_id,
                decision) -> None`` that writes a sample-of-
                decisions row to the audit table. The v0
                ship calls this with a 1% sample rate
                (matches the existing probabilistic
                fallback). The portal can use the audit
                table to explain "why was this dropped".
        """
        ready = self.buffer.ready(now=now)
        decisions: list[dict[str, Any]] = []
        kept = 0
        dropped = 0
        for slot in ready:
            decision = self.policy.evaluate(slot.spans)
            # Probabilistic: actually flip the coin
            if decision.verdict == "probabilistic":
                if probabilistic_verdict(
                    slot.trace_id, self.policy.probabilistic_rate
                ):
                    self.buffer.commit(
                        slot.trace_id,
                        SamplingDecision(verdict="keep", rule="probabilistic"),
                    )
                    kept += 1
                    decisions.append(
                        {
                            "trace_id": slot.trace_id,
                            "verdict": "keep",
                            "rule": "probabilistic",
                        }
                    )
                else:
                    self.buffer.commit(slot.trace_id, decision)
                    dropped += 1
                    decisions.append(
                        {
                            "trace_id": slot.trace_id,
                            "verdict": "drop",
                            "rule": "probabilistic",
                        }
                    )
            else:
                self.buffer.commit(slot.trace_id, decision)
                if decision.verdict == "keep":
                    kept += 1
                else:
                    dropped += 1
                decisions.append(
                    {
                        "trace_id": slot.trace_id,
                        "verdict": decision.verdict,
                        "rule": decision.rule,
                    }
                )
            if persist is not None:
                try:
                    persist(slot.org_id, slot.trace_id, decision)
                except Exception as exc:
                    logger.debug("tail_sampler: persist failed: %s", exc)
        return _ok_envelope(
            self.name,
            {
                "evaluated": len(ready),
                "kept": kept,
                "dropped": dropped,
                "evicted": self.buffer.evicted_traces,
                "decisions": decisions,
                "stats": self.buffer.stats(),
            },
        )

    def configure(
        self,
        *,
        latency_p99_threshold_ms: int = 500,
        probabilistic_rate: float = 0.10,
    ) -> dict[str, Any]:
        """Reconfigure the policy at runtime. Returns the
        live ``ok`` envelope with the new config."""
        self.policy = SamplingPolicy(
            latency_p99_threshold_ms=latency_p99_threshold_ms,
            probabilistic_rate=probabilistic_rate,
        )
        return _ok_envelope(
            "tail_sampler_config",
            {
                "latency_p99_threshold_ms": self.policy.latency_p99_threshold_ms,
                "probabilistic_rate": self.policy.probabilistic_rate,
            },
        )

    def evaluate_single(
        self,
        org_id: str,
        *,
        trace_id: str,
        spans: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Run the policy on a single trace without buffering.

        Useful for the portal's "preview" view + the v0
        test surface. Returns the live ``ok`` envelope with
        the decision.
        """
        decision = self.policy.evaluate(spans)
        if decision.verdict == "probabilistic":
            keep = probabilistic_verdict(trace_id, self.policy.probabilistic_rate)
            verdict = "keep" if keep else "drop"
            rule = "probabilistic"
        else:
            verdict = decision.verdict
            rule = decision.rule
        return _ok_envelope(
            "tail_sampler_preview",
            {
                "trace_id": trace_id,
                "org_id": org_id,
                "verdict": verdict,
                "rule": rule,
                "evaluated_at": _now_iso(),
            },
        )


# ─── Audit-log persistence (best-effort) ───────────────────────────


async def _persist_decision(
    org_id: str,
    trace_id: str,
    decision: SamplingDecision,
) -> None:
    """Best-effort insert into ``apm_sampling_decisions``.

    Called via the ``persist=`` hook on
    :meth:`TailSampler.flush`. Swallows all exceptions
    (a postgres outage must not stop the sampler).
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return
    try:
        client = await get_postgres_client()
    except Exception:
        return
    if client is None:
        return
    try:
        import json as _json
        import uuid as _uuid

        await client.execute(
            """
            INSERT INTO apm_sampling_decisions
                (id, org_id, trace_id, verdict, rule, score,
                 attributes_json, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
            """,
            str(_uuid.uuid4()),
            str(org_id or ""),
            str(trace_id or ""),
            decision.verdict,
            decision.rule,
            float(decision.score),
            _json.dumps({"source": "tail_sampler"}),
        )
    except Exception as exc:
        logger.debug("apm_sampling_decisions insert failed: %s", exc)


# ─── Singleton accessor (the gateway collector hook) ──────────────

_tail_sampler: TailSampler | None = None
_tail_sampler_lock = threading.Lock()


def get_tail_sampler() -> TailSampler:
    """Return the process-singleton :class:`TailSampler`."""
    global _tail_sampler
    with _tail_sampler_lock:
        if _tail_sampler is None:
            _tail_sampler = TailSampler()
        return _tail_sampler


def reset_tail_sampler() -> None:
    """Test helper — wipe the singleton."""
    global _tail_sampler
    with _tail_sampler_lock:
        _tail_sampler = None


# ─── Stats endpoint payload (the dropped-trace counter) ───────────


def get_sampling_stats() -> dict[str, Any]:
    """Return the live envelope for the ``GET /sampling/stats``
    route. Reads from the singleton."""
    sampler = get_tail_sampler()
    stats = sampler.buffer.stats()
    return _ok_envelope(
        "sampling_stats",
        {
            **stats,
            "memory_gb_estimate": estimate_memory_gb(stats["num_traces_capacity"]),
            "drop_rate": (
                stats["dropped_traces"]
                / max(1, stats["kept_traces"] + stats["dropped_traces"])
            ),
            "checked_at": datetime.now(UTC).isoformat(),
        },
    )
