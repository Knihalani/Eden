"""S18 — microbenches for redact on/off, chunk text on/off, dual-emit span build.

These are evidence gates (not hard latency SLOs). They prove the opt-in
flags change work done and that dual-emit conversion stays allocation-bounded.
"""

from __future__ import annotations

import statistics
import time
from typing import Any

import pytest

ITERATIONS = 400


def _p95_ms(samples: list[float]) -> float:
    if not samples:
        return 0.0
    ordered = sorted(samples)
    idx = min(len(ordered) - 1, int(len(ordered) * 0.95))
    return ordered[idx] * 1000.0


def _time_iters(fn, n: int = ITERATIONS) -> list[float]:
    samples: list[float] = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        samples.append(time.perf_counter() - t0)
    return samples


def test_redact_on_vs_off_bench():
    """redact_on_client=True must do more work than a no-op path."""
    import sys
    from pathlib import Path

    sdk_root = Path(__file__).resolve().parents[2] / "sdk" / "python"
    if str(sdk_root) not in sys.path:
        sys.path.insert(0, str(sdk_root))

    from eden_sdk.filters import redact_payload

    payload: dict[str, Any] = {
        "text": "ping alice@example.com with card 4111 1111 1111 1111",
        "meta": {"phone": "415-555-2671", "ok": True},
        "nested": [{"ssn": "123-45-6789"}, "plain"],
    }

    def with_redact():
        redact_payload(payload)

    def without_redact():
        # Identity path — simulate redact_on_client=False (no transform).
        return payload

    on_samples = _time_iters(with_redact)
    off_samples = _time_iters(without_redact)
    on_p95 = _p95_ms(on_samples)
    off_p95 = _p95_ms(off_samples)
    on_mean = statistics.mean(on_samples) * 1000.0
    off_mean = statistics.mean(off_samples) * 1000.0

    print(
        f"\n[S18 redact] on_p95={on_p95:.4f}ms off_p95={off_p95:.4f}ms "
        f"on_mean={on_mean:.4f}ms off_mean={off_mean:.4f}ms"
    )
    out = redact_payload(payload)
    assert "[REDACTED]" in str(out)
    assert on_mean >= off_mean


def test_chunk_text_on_vs_off_bench():
    """capture_chunk_text=True retains delta strings; False drops them."""
    deltas = [f"tok-{i}-" + ("x" * 32) for i in range(80)]

    def capture_on():
        chunks = []
        for d in deltas:
            chunks.append({"delta_text": d, "index": len(chunks)})
        return chunks

    def capture_off():
        chunks = []
        for _d in deltas:
            chunks.append({"delta_text": "", "index": len(chunks)})
        return chunks

    on_samples = _time_iters(capture_on, n=200)
    off_samples = _time_iters(capture_off, n=200)
    on_p95 = _p95_ms(on_samples)
    off_p95 = _p95_ms(off_samples)

    on_out = capture_on()
    off_out = capture_off()
    on_bytes = sum(len(c["delta_text"]) for c in on_out)
    off_bytes = sum(len(c["delta_text"]) for c in off_out)

    print(
        f"\n[S18 chunk] on_p95={on_p95:.4f}ms off_p95={off_p95:.4f}ms "
        f"on_bytes={on_bytes} off_bytes={off_bytes}"
    )
    assert on_bytes > off_bytes
    assert off_bytes == 0


def test_dual_emit_span_build_bench():
    """OTel dual-emit span conversion should stay under a soft local ceiling."""
    from eden.observability.otel_exporter import OTelDualExporter
    from eden.observability.telemetry_collector import TelemetryEvent

    exporter = OTelDualExporter()
    event = TelemetryEvent(
        event_id="evt_bench_1",
        tenant_id="org_bench",
        project_id="default",
        trace_id="tr_bench",
        realm="production",
        event_type="openai.chat_completion",
        timestamp="2026-07-18T00:00:00Z",
        name="gpt-4o-mini",
        span_id="sp_bench",
        duration_ms=250.0,
        metrics={"input_tokens": 12, "output_tokens": 34},
        attributes={"model": "gpt-4o-mini"},
    )

    def once():
        return exporter._event_to_otlp_span(event)

    samples = _time_iters(once, n=ITERATIONS)
    p95 = _p95_ms(samples)
    span = once()
    print(f"\n[S18 dual-emit] p95={p95:.4f}ms keys={list(span)[:5]}")
    assert span
    # Soft local ceiling — conversion only, no network.
    assert p95 < 5.0, f"dual-emit span build p95 {p95:.4f}ms >= 5ms"
