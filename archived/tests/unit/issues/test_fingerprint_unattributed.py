"""BUG-12 — unattributed stumbles must not share one fingerprint bucket."""

from __future__ import annotations

import hashlib

from eden.issues.fingerprint import (
    compute_fingerprint,
    error_signature_for,
)


def test_null_agent_different_traces_get_different_fingerprints() -> None:
    sig = error_signature_for(
        "tool_error", {"tool_name": "search", "error": "timeout"}
    )
    fp_a = compute_fingerprint("tool_error", None, sig, trace_id="trace-a")
    fp_b = compute_fingerprint("tool_error", None, sig, trace_id="trace-b")
    assert fp_a != fp_b


def test_same_agent_same_kind_signature_still_collides() -> None:
    sig = error_signature_for(
        "tool_error", {"tool_name": "search", "error": "timeout"}
    )
    fp_a = compute_fingerprint("tool_error", "agent-1", sig, trace_id="trace-a")
    fp_b = compute_fingerprint("tool_error", "agent-1", sig, trace_id="trace-b")
    assert fp_a == fp_b


def test_legacy_unknown_bucket_not_used_for_missing_agent() -> None:
    sig = "search|timeout"
    old_shared = hashlib.sha256(f"tool_error|unknown|{sig}".encode()).hexdigest()[
        :32
    ]
    new_fp = compute_fingerprint("tool_error", None, sig, trace_id="trace-1")
    assert new_fp != old_shared


def test_no_trace_id_uses_non_shared_fallback() -> None:
    sig = "search|timeout"
    fp_a = compute_fingerprint("tool_error", None, sig)
    fp_b = compute_fingerprint("tool_error", None, sig, trace_id="trace-1")
    assert fp_a != fp_b
    assert fp_a == compute_fingerprint("tool_error", None, sig)
