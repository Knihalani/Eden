"""Unit tests for the §9.2.1 cost report generator."""

import pytest

from eden.optimization.cost_tracker import (
    MonthlyCostReport,
    generate_monthly_report,
)


class _FakeEvent:
    def __init__(self, tenant_id, day, model, node, cost_cents, tokens):
        self.tenant_id = tenant_id
        self.timestamp = _parse_day(day)
        self.model = model
        self.node = node
        self.cost_cents = cost_cents
        self.tokens = tokens


def _parse_day(s: str):
    from datetime import datetime
    return datetime.fromisoformat(s)


def test_generate_monthly_report_filters_by_tenant_and_month():
    events = [
        _FakeEvent("t1", "2026-06-01", "openai", "planner", 100, 1000),
        _FakeEvent("t1", "2026-06-15", "anthropic", "executor", 50, 500),
        _FakeEvent("t1", "2026-05-15", "openai", "planner", 999, 9999),  # wrong month
        _FakeEvent("t2", "2026-06-15", "openai", "planner", 200, 2000),  # wrong tenant
    ]
    r = generate_monthly_report("t1", "2026-06", events)
    assert isinstance(r, MonthlyCostReport)
    assert r.tenant_id == "t1"
    assert r.year_month == "2026-06"
    assert r.total_cents == 150.0
    assert r.total_tokens == 1500
    assert r.by_model == {"openai": 100.0, "anthropic": 50.0}
    assert r.by_node == {"planner": 100.0, "executor": 50.0}


def test_generate_monthly_report_empty():
    r = generate_monthly_report("t1", "2026-06", [])
    assert r.total_cents == 0.0
    assert r.by_model == {}
    assert r.by_node == {}


def test_generate_monthly_report_with_only_other_tenant():
    events = [_FakeEvent("t2", "2026-06-01", "openai", "planner", 100, 1000)]
    r = generate_monthly_report("t1", "2026-06", events)
    assert r.total_cents == 0.0


def test_generate_cost_report_aggregates_per_node():
    events = [
        _FakeEvent("t1", "2026-06-01", "openai", "planner", 10, 100),
        _FakeEvent("t1", "2026-06-02", "openai", "planner", 20, 200),
        _FakeEvent("t1", "2026-06-03", "openai", "executor", 30, 300),
    ]
    r = generate_monthly_report("t1", "2026-06", events)
    assert r.by_node == {"planner": 30.0, "executor": 30.0}
    assert r.by_model == {"openai": 60.0}
