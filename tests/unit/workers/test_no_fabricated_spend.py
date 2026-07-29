"""A path that calls no model must not book money.

``trace_finalized_consumer`` booked a hardcoded ``cost_usd=0.03`` per
investigated trace against ``feature="signal_investigator"``. There is
no model behind that path: the per-signal LLM investigator was removed
and ``signals/investigator.py`` is heuristics only — its
``_one_completion`` raises.

Fabricated spend is not merely a wrong dashboard. The per-org budgets
read the same ledger, so it consumes real allowance. At 1,000
traces/day it invents $30/day on its own, which is past the $25/day
``daily_maintenance_budget_usd`` — so once the budget gates work (the
annotator gate was fixed the same day), imaginary spend starts blocking
real work.
"""

from __future__ import annotations

import inspect

import pytest


def test_investigator_metering_books_zero_dollars():
    """The consumer may record that the path ran; it may not price it."""
    from eden.workers import trace_finalized_consumer as tfc

    src = inspect.getsource(tfc)
    assert "cost_usd=0.03" not in src, (
        "trace_finalized_consumer must not book a hardcoded $0.03 for a "
        "path that makes no model call — the per-org budget reads this "
        "ledger and would be consumed by spend that never happened"
    )


@pytest.mark.asyncio
async def test_investigator_cost_event_is_zero(monkeypatch):
    """Behavioural counterpart to the source assertion above."""
    from eden.workers import trace_finalized_consumer as tfc

    events = []

    async def _capture(event):
        events.append(event)
        return True

    async def _noop_investigate(org_id, trace_id, **kw):
        return []

    monkeypatch.setattr(
        "eden.llmops.cost_ledger.record_cost_event", _capture
    )
    monkeypatch.setattr(
        "eden.signals.investigator.investigate_trace", _noop_investigate
    )

    fn = getattr(tfc, "_run_signal_investigator", None)
    if fn is None:
        pytest.skip("investigator hook not exposed under the expected name")

    await fn("org-1", "trace-1")

    priced = [e for e in events if getattr(e, "feature", "") == "signal_investigator"]
    if not priced:
        pytest.skip("investigator did not emit a cost event in this config")
    for e in priced:
        assert float(e.cost_usd) == 0.0, (
            f"signal_investigator booked {e.cost_usd}; that path spends nothing"
        )
        # The comparison figure survives, as metadata rather than money.
        assert (e.metadata or {}).get("notional_cost_usd") == 0.03


def test_classifier_savings_constant_is_not_wired_to_a_ledger():
    """INVESTIGATOR_COST_USD is a yardstick for the shadow-mode savings
    report. It must stay out of CostEvent.cost_usd."""
    from eden.signals import classifier_worker

    src = inspect.getsource(classifier_worker)
    assert "INVESTIGATOR_COST_USD" in src
    assert "cost_usd=INVESTIGATOR_COST_USD" not in src, (
        "the notional investigator cost must never become ledger spend"
    )
