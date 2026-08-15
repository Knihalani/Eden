"""Tests for prompt canary traffic split (Phase 7.2c)."""

import sys

import pytest

sys.path.insert(0, "src")

from eden.agents.prompt_canary import _stable_roll, pick_canary_version


def test_stable_roll_is_deterministic():
    """Same (tenant, agent, minute) → same roll."""
    r1 = _stable_roll("tenant-1", "planner", 12345)
    r2 = _stable_roll("tenant-1", "planner", 12345)
    assert r1 == r2


def test_stable_roll_varies_by_tenant():
    r1 = _stable_roll("tenant-1", "planner", 12345)
    r2 = _stable_roll("tenant-2", "planner", 12345)
    assert r1 != r2


def test_stable_roll_varies_by_agent():
    r1 = _stable_roll("tenant-1", "planner", 12345)
    r2 = _stable_roll("tenant-1", "critic", 12345)
    assert r1 != r2


def test_stable_roll_varies_by_minute():
    r1 = _stable_roll("tenant-1", "planner", 12345)
    r2 = _stable_roll("tenant-1", "planner", 12346)
    assert r1 != r2


def test_stable_roll_in_unit_interval():
    r = _stable_roll("tenant-1", "planner", 12345)
    assert 0.0 <= r < 1.0


def test_pick_canary_empty_returns_none():
    assert pick_canary_version([], "t1", "planner") is None


def test_pick_canary_100_percent_always_wins():
    a = [{"version": 1, "traffic_pct": 100}]
    for m in range(100):
        assert pick_canary_version(a, f"t-{m}", "planner")["version"] == 1


def test_pick_canary_distribution():
    """1000 trials, 70/30 split — expect ~700/300 ±5%."""
    a = [
        {"version": 1, "traffic_pct": 70},
        {"version": 2, "traffic_pct": 30},
    ]
    counts = {1: 0, 2: 0}
    for m in range(1000):
        r = pick_canary_version(a, f"t-{m}", "planner")
        counts[r["version"]] += 1
    # Allow 5% margin
    assert 650 <= counts[1] <= 750
    assert 250 <= counts[2] <= 350


def test_pick_canary_stability_for_same_tenant():
    """Same (tenant, agent) at consecutive minutes can pick different
    buckets — that's expected. But within a single minute, the
    decision is stable (we cache by minute)."""
    a = [
        {"version": 1, "traffic_pct": 50},
        {"version": 2, "traffic_pct": 50},
    ]
    # Within a single minute → same answer for the same tenant
    picks = {
        pick_canary_version(a, "t1", "planner")["version"]
        for _ in range(50)
    }
    assert len(picks) == 1  # only one version was selected in that minute
