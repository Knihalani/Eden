"""Unit tests for ``eden_sdk.capture`` — bounded capture policy.

Covers the three ``capture_mode`` values (``bounded`` / ``full`` /
``metrics_only``), the error/slow bypass, and the metadata stamped
onto ``attributes`` so a truncated payload is never indistinguishable
from a short one on the wire.
"""

from __future__ import annotations

import eden
from eden_sdk.capture import (
    CAPTURE_MODE_ATTR,
    ORIGINAL_BYTES_ATTR,
    TRUNCATED_ATTR,
    CaptureLimits,
    capture_request_response,
    capture_value,
    limits_from_config,
    stamp_capture_attributes,
    truncate_text,
)
from eden_sdk.config import EdenConfig, get_config


# ── truncate_text ───────────────────────────────────────────────────


def test_truncate_text_under_limit_is_unchanged():
    text = "short string"
    out, truncated, original_bytes = truncate_text(text, max_bytes=1024)
    assert out == text
    assert truncated is False
    assert original_bytes == len(text.encode("utf-8"))


def test_truncate_text_over_limit_is_shortened_and_keeps_head_and_tail():
    text = "HEAD" * 100 + "MIDDLE" * 1000 + "TAIL" * 100
    out, truncated, original_bytes = truncate_text(text, max_bytes=256)
    assert truncated is True
    assert original_bytes == len(text.encode("utf-8"))
    assert len(out.encode("utf-8")) <= 256 + 64  # marker itself takes some budget
    # Both edges of the original text should still be present.
    assert out.startswith("HEAD")
    assert out.endswith("TAIL")
    assert "…[eden:truncated" in out


def test_truncate_text_marker_reports_correct_omitted_byte_count():
    text = "x" * 10_000
    out, truncated, original_bytes = truncate_text(text, max_bytes=100)
    assert truncated is True
    assert original_bytes == 10_000
    # The marker should mention how many bytes were dropped.
    omitted = original_bytes - 100
    assert f"{omitted}b" in out


def test_truncate_text_non_positive_budget_drops_everything():
    out, truncated, original_bytes = truncate_text("hello", max_bytes=0)
    assert out == ""
    assert truncated is True
    assert original_bytes == 5


def test_truncate_text_empty_string_is_never_truncated():
    out, truncated, original_bytes = truncate_text("", max_bytes=0)
    assert out == ""
    assert truncated is False
    assert original_bytes == 0


def test_truncate_text_multibyte_boundary_never_raises():
    # Emoji is 4 UTF-8 bytes; a naive byte-slice could cut mid-codepoint.
    text = "🎉" * 500
    out, truncated, original_bytes = truncate_text(text, max_bytes=37)
    assert truncated is True
    assert isinstance(out, str)  # decode(errors="ignore") never raises


# ── capture_value: bounded mode ────────────────────────────────────


def test_capture_value_bounded_truncates_long_string_field():
    limits = CaptureLimits(mode="bounded", max_string_bytes=32)
    result = capture_value("y" * 1000, limits=limits)
    assert result.truncated is True
    assert result.original_bytes == 1000
    assert result.mode == "bounded"
    assert len(result.value.encode("utf-8")) < 1000


def test_capture_value_bounded_leaves_short_string_untouched():
    limits = CaptureLimits(mode="bounded", max_string_bytes=8192)
    result = capture_value("hi", limits=limits)
    assert result.truncated is False
    assert result.value == "hi"
    assert result.original_bytes == 2


def test_capture_value_bounded_walks_nested_structures():
    limits = CaptureLimits(mode="bounded", max_string_bytes=16)
    value = {
        "messages": [
            {"role": "system", "content": "s" * 500},
            {"role": "user", "content": "short"},
        ],
        "temperature": 0.7,
        "n": 1,
    }
    result = capture_value(value, limits=limits)
    assert result.truncated is True
    # Structure (dict keys, list length, non-string scalars) survives.
    assert len(result.value["messages"]) == 2
    assert result.value["temperature"] == 0.7
    assert result.value["n"] == 1
    # The long field was shortened; the short one was not touched.
    assert len(result.value["messages"][0]["content"]) < 500
    assert result.value["messages"][1]["content"] == "short"


def test_capture_value_none_passthrough_in_every_mode():
    for mode in ("bounded", "full", "metrics_only"):
        result = capture_value(None, limits=CaptureLimits(mode=mode))
        assert result.value is None
        assert result.truncated is False


# ── capture_value: error / slow bypass ─────────────────────────────


def test_capture_value_error_bypasses_truncation():
    limits = CaptureLimits(mode="bounded", max_string_bytes=8)
    result = capture_value("z" * 10_000, has_error=True, limits=limits)
    assert result.truncated is False
    assert result.value == "z" * 10_000


def test_capture_value_slow_duration_bypasses_truncation():
    limits = CaptureLimits(mode="bounded", max_string_bytes=8, slow_threshold_ms=5_000.0)
    result = capture_value(
        "w" * 10_000, has_error=False, duration_ms=5_001.0, limits=limits
    )
    assert result.truncated is False
    assert result.value == "w" * 10_000


def test_capture_value_duration_at_threshold_still_truncates():
    """Bypass is strictly-greater-than, matching sampling's force-keep."""
    limits = CaptureLimits(mode="bounded", max_string_bytes=8, slow_threshold_ms=5_000.0)
    result = capture_value(
        "w" * 10_000, has_error=False, duration_ms=5_000.0, limits=limits
    )
    assert result.truncated is True


def test_capture_value_fast_success_is_bounded():
    limits = CaptureLimits(mode="bounded", max_string_bytes=8, slow_threshold_ms=5_000.0)
    result = capture_value(
        "v" * 10_000, has_error=False, duration_ms=10.0, limits=limits
    )
    assert result.truncated is True


# ── capture_value: full / metrics_only modes ───────────────────────


def test_capture_value_full_mode_never_truncates_even_when_huge():
    limits = CaptureLimits(mode="full", max_string_bytes=8)
    long_text = "a" * 200_000
    result = capture_value(long_text, limits=limits)
    assert result.truncated is False
    assert result.value == long_text
    assert result.mode == "full"


def test_capture_value_full_mode_ignores_error_and_slow_flags_the_same_way():
    """full bypasses truncation unconditionally; the error/slow flags
    are irrelevant to a mode that never truncates anyway."""
    limits = CaptureLimits(mode="full", max_string_bytes=8)
    long_text = "b" * 5_000
    for has_error, duration_ms in ((False, 1.0), (True, 1.0), (False, 99_999.0)):
        result = capture_value(
            long_text, has_error=has_error, duration_ms=duration_ms, limits=limits
        )
        assert result.value == long_text
        assert result.truncated is False


def test_capture_value_metrics_only_drops_content_entirely():
    limits = CaptureLimits(mode="metrics_only")
    result = capture_value({"messages": [{"content": "hi"}]}, limits=limits)
    assert result.value is None
    assert result.truncated is False
    assert result.mode == "metrics_only"


def test_capture_value_metrics_only_wins_even_on_error():
    """metrics_only means "never capture content" — an error does not
    reintroduce content, it only affects bounded mode's truncation."""
    limits = CaptureLimits(mode="metrics_only")
    result = capture_value("secret prompt", has_error=True, limits=limits)
    assert result.value is None


# ── stamp_capture_attributes ────────────────────────────────────────


def test_stamp_capture_attributes_marks_truncated_true_when_any_side_truncated():
    limits = CaptureLimits(mode="bounded", max_string_bytes=8)
    req = capture_value("short", limits=limits)
    resp = capture_value("y" * 1000, limits=limits)
    attrs: dict = {}
    stamp_capture_attributes(attrs, req, resp)
    assert attrs[TRUNCATED_ATTR] == "true"
    assert attrs[ORIGINAL_BYTES_ATTR] == str(5 + 1000)
    assert attrs[CAPTURE_MODE_ATTR] == "bounded"


def test_stamp_capture_attributes_marks_truncated_false_when_neither_truncated():
    limits = CaptureLimits(mode="bounded", max_string_bytes=8192)
    req = capture_value("short req", limits=limits)
    resp = capture_value("short resp", limits=limits)
    attrs: dict = {}
    stamp_capture_attributes(attrs, req, resp)
    assert attrs[TRUNCATED_ATTR] == "false"


def test_stamp_capture_attributes_values_are_strings_for_wire_safety():
    limits = CaptureLimits(mode="bounded", max_string_bytes=8)
    result = capture_value("z" * 1000, limits=limits)
    attrs: dict = {}
    stamp_capture_attributes(attrs, result)
    for v in attrs.values():
        assert isinstance(v, str)


def test_stamp_capture_attributes_noop_with_no_results():
    attrs = {"existing": "1"}
    out = stamp_capture_attributes(attrs)
    assert out == {"existing": "1"}
    assert TRUNCATED_ATTR not in out


# ── capture_request_response ────────────────────────────────────────


def test_capture_request_response_combines_both_sides_and_returns_attrs():
    limits = CaptureLimits(mode="bounded", max_string_bytes=16)
    req_val, resp_val, attrs = capture_request_response(
        {"messages": [{"content": "r" * 500}]},
        {"choices": [{"message": {"content": "o" * 500}}]},
        error=None,
        duration_ms=5.0,
        limits=limits,
    )
    assert len(req_val["messages"][0]["content"]) < 500
    assert len(resp_val["choices"][0]["message"]["content"]) < 500
    assert attrs[TRUNCATED_ATTR] == "true"


def test_capture_request_response_error_keeps_both_sides_full():
    limits = CaptureLimits(mode="bounded", max_string_bytes=16)
    long_req = {"messages": [{"content": "r" * 5_000}]}
    long_resp = {"choices": [{"message": {"content": "o" * 5_000}}]}
    req_val, resp_val, attrs = capture_request_response(
        long_req, long_resp, error="boom", duration_ms=5.0, limits=limits
    )
    assert req_val == long_req
    assert resp_val == long_resp
    assert attrs[TRUNCATED_ATTR] == "false"


def test_capture_request_response_metrics_only_drops_both_sides():
    limits = CaptureLimits(mode="metrics_only")
    req_val, resp_val, attrs = capture_request_response(
        {"messages": [{"content": "hi"}]},
        {"choices": []},
        error=None,
        duration_ms=1.0,
        limits=limits,
    )
    assert req_val is None
    assert resp_val is None
    assert attrs[CAPTURE_MODE_ATTR] == "metrics_only"


# ── limits_from_config ──────────────────────────────────────────────


def test_limits_from_config_reads_capture_mode_and_max_bytes():
    cfg = EdenConfig(capture_mode="full", capture_max_string_bytes=123)
    limits = limits_from_config(cfg)
    assert limits.mode == "full"
    assert limits.max_string_bytes == 123


def test_limits_from_config_invalid_mode_falls_back_to_bounded():
    cfg = EdenConfig(capture_mode="not-a-real-mode")
    limits = limits_from_config(cfg)
    assert limits.mode == "bounded"


def test_limits_from_config_none_falls_back_to_env_defaults():
    limits = limits_from_config(None)
    assert limits.mode in ("bounded", "full", "metrics_only")
    assert limits.max_string_bytes > 0


def test_limits_from_config_non_positive_max_bytes_falls_back_to_default():
    cfg = EdenConfig(capture_mode="bounded", capture_max_string_bytes=0)
    limits = limits_from_config(cfg)
    assert limits.max_string_bytes == 8192


# ── EdenConfig / configure() knobs ──────────────────────────────────


def test_configure_capture_mode_defaults_to_bounded():
    eden.configure(org_id="o", api_key="k", dry_run=True)
    assert get_config().capture_mode == "bounded"
    assert get_config().capture_max_string_bytes == 8192


def test_configure_can_set_capture_mode_to_full():
    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="full")
    assert get_config().capture_mode == "full"


def test_configure_can_set_capture_mode_to_metrics_only():
    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="metrics_only")
    assert get_config().capture_mode == "metrics_only"


def test_configure_can_set_capture_max_string_bytes():
    eden.configure(org_id="o", api_key="k", dry_run=True, capture_max_string_bytes=256)
    assert get_config().capture_max_string_bytes == 256


def test_env_capture_mode_is_read_by_from_env(monkeypatch):
    monkeypatch.setenv("EDEN_CAPTURE_MODE", "full")
    monkeypatch.setenv("EDEN_CAPTURE_MAX_STRING_BYTES", "999")
    from eden_sdk.config import _from_env

    cfg = _from_env()
    assert cfg.capture_mode == "full"
    assert cfg.capture_max_string_bytes == 999
