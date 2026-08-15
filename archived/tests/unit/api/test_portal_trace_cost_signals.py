"""Portal trace signal summary + cost resolution helpers."""

from __future__ import annotations

from eden.api.routes.portal import _resolved_trace_cost_usd, _trace_signal_summary


def test_clean_run_signal_summary_has_title() -> None:
    s = _trace_signal_summary(name="checkout", severity="none", status="ok")
    assert s.title == "Clean run"
    assert s.count == 0
    assert "detectors" in s.body.lower()


def test_failed_run_signal_summary() -> None:
    s = _trace_signal_summary(name="checkout", severity="error", status="error")
    assert s.title == "Run failed"
    assert s.count == 1


def test_resolved_cost_keeps_stamped() -> None:
    assert (
        _resolved_trace_cost_usd(
            cost_usd=0.42,
            input_tokens=1000,
            output_tokens=1000,
            model="gpt-4o",
        )
        == 0.42
    )


def test_resolved_cost_estimates_when_zero() -> None:
    cost = _resolved_trace_cost_usd(
        cost_usd=0.0,
        input_tokens=1000,
        output_tokens=1000,
        model="gpt-4o",
    )
    assert cost > 0
