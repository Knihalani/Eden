"""Unit tests for BudgetEnvelope — F83 workstream #6 shared type."""

from __future__ import annotations

import pytest

from eden.optimization.budget_envelope import BudgetEnvelope


class TestBudgetEnvelopeFromBudgetService:
    def test_ok_status_when_under_limits(self):
        cfg = {
            "org_id": "org-1",
            "window": "monthly",
            "cost_soft_limit_usd": 5.0,
            "cost_hard_limit_usd": 10.0,
        }
        cons = {"org_id": "org-1", "cost_usd": 2.0}
        env = BudgetEnvelope.from_budget_service(cfg, cons)
        assert env.status == BudgetEnvelope.STATUS_OK
        assert env.source == "budget_service"
        assert env.cost_usd == 2.0
        assert env.utilisation_pct == 20.0
        assert not env.is_over_soft()
        assert not env.is_over_hard()

    def test_soft_limit_status(self):
        cfg = {
            "org_id": "org-1",
            "window": "monthly",
            "cost_soft_limit_usd": 5.0,
            "cost_hard_limit_usd": 10.0,
        }
        cons = {"org_id": "org-1", "cost_usd": 7.0}
        env = BudgetEnvelope.from_budget_service(cfg, cons)
        assert env.status == BudgetEnvelope.STATUS_SOFT
        assert env.is_over_soft()
        assert not env.is_over_hard()

    def test_hard_limit_status(self):
        cfg = {
            "org_id": "org-1",
            "window": "monthly",
            "cost_soft_limit_usd": 5.0,
            "cost_hard_limit_usd": 10.0,
        }
        cons = {"org_id": "org-1", "cost_usd": 12.0}
        env = BudgetEnvelope.from_budget_service(cfg, cons)
        assert env.status == BudgetEnvelope.STATUS_HARD
        assert env.is_over_hard()
        assert env.utilisation_pct == 100.0

    def test_infinite_hard_limit(self):
        cfg = {
            "org_id": "org-1",
            "window": "monthly",
            "cost_soft_limit_usd": float("inf"),
            "cost_hard_limit_usd": float("inf"),
        }
        cons = {"org_id": "org-1", "cost_usd": 999.0}
        env = BudgetEnvelope.from_budget_service(cfg, cons)
        assert env.status == BudgetEnvelope.STATUS_OK
        assert env.utilisation_pct == 0.0

    def test_as_dict_contains_expected_keys(self):
        cfg = {
            "org_id": "org-1",
            "window": "monthly",
            "cost_soft_limit_usd": 1.0,
            "cost_hard_limit_usd": 2.0,
        }
        cons = {"org_id": "org-1", "cost_usd": 0.5}
        env = BudgetEnvelope.from_budget_service(cfg, cons)
        d = env.as_dict()
        assert "org_id" in d
        assert "cost_usd" in d
        assert "status" in d
        assert "source" in d
        assert "snapshot_at" in d


class TestBudgetEnvelopeFromCostTracker:
    def test_ok_status(self):
        stats = {"total_tracked_cents": 50.0}
        env = BudgetEnvelope.from_cost_tracker(
            "org-2", stats, soft_limit_cents=200.0, hard_limit_cents=500.0
        )
        assert env.status == BudgetEnvelope.STATUS_OK
        assert env.source == "cost_tracker"
        assert env.cost_usd == pytest.approx(0.5, rel=1e-3)

    def test_soft_limit(self):
        stats = {"total_tracked_cents": 300.0}
        env = BudgetEnvelope.from_cost_tracker(
            "org-2", stats, soft_limit_cents=200.0, hard_limit_cents=500.0
        )
        assert env.status == BudgetEnvelope.STATUS_SOFT

    def test_hard_limit(self):
        stats = {"total_tracked_cents": 600.0}
        env = BudgetEnvelope.from_cost_tracker(
            "org-2", stats, soft_limit_cents=200.0, hard_limit_cents=500.0
        )
        assert env.status == BudgetEnvelope.STATUS_HARD
        assert env.is_over_hard()

    def test_no_limits(self):
        stats = {"total_tracked_cents": 9999.0}
        env = BudgetEnvelope.from_cost_tracker("org-2", stats)
        assert env.status == BudgetEnvelope.STATUS_OK
