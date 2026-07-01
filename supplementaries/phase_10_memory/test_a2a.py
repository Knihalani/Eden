"""Tests for Phase 10 Memory + A2A."""
from __future__ import annotations

import pytest

from supplementaries.phase_10_memory.a2a import (
    A2A_STATES,
    A2ATaskState,
    A2A_INPUT_REQUIRED_THRESHOLD_S,
    BlackboardStale,
    DepthAlert,
    MemoryBloatAlert,
    MemoryConflict,
    TopologyAlert,
    detect_agent_depth_runaway,
    detect_blackboard_stale,
    detect_memory_bloat,
    detect_memory_conflicts,
    detect_memory_paging_pressure,
    detect_swarm_topology,
    emit_drift_alert,
    is_stuck_state,
    parse_a2a_event,
)


# ── A2A protocol ingestion ────────────────────────────────────


def test_a2a_states_canonical():
    """9 canonical states per A2A v1.0 (canceled single-l American)."""
    assert "canceled" in A2A_STATES
    assert "cancelled" not in A2A_STATES
    assert "submitted" in A2A_STATES
    assert "rejected" in A2A_STATES
    assert len(A2A_STATES) == 9


def test_parse_a2a_event_complete():
    event = {
        "task_id": "task_123",
        "agent_id": "agent_billing",
        "parent_agent_id": "agent_intake",
        "method": "message/send",
        "state": "input-required",
        "started_at": "2026-06-28T12:00:00Z",
        "skill_id": "refund_lookup",
        "context_id": "ctx_456",
    }
    parsed = parse_a2a_event(event)
    assert isinstance(parsed, A2ATaskState)
    assert parsed.task_id == "task_123"
    assert parsed.state == "input-required"


def test_parse_a2a_event_camel_case():
    """Accept camelCase keys (per A2A JSON-RPC convention)."""
    event = {
        "taskId": "task_456",
        "agentId": "agent_x",
        "method": "tasks/get",
        "state": "completed",
    }
    parsed = parse_a2a_event(event)
    assert parsed.task_id == "task_456"
    assert parsed.agent_id == "agent_x"


def test_parse_a2a_event_unknown_state():
    """Unknown state names are coerced to 'unknown'."""
    event = {"task_id": "t1", "agent_id": "a1", "state": "invalid_state_xyz"}
    parsed = parse_a2a_event(event)
    assert parsed.state == "unknown"


def test_parse_a2a_event_missing_fields():
    assert parse_a2a_event({}) is None
    assert parse_a2a_event({"task_id": "t1"}) is None
    assert parse_a2a_event({"agent_id": "a1"}) is None


def test_is_stuck_state_input_required_long():
    assert is_stuck_state("input-required", 35 * 60)  # 35 min


def test_is_stuck_state_input_required_short():
    assert not is_stuck_state("input-required", 5 * 60)  # 5 min


def test_is_stuck_state_completed_not_stuck():
    assert not is_stuck_state("completed", 60 * 60)


def test_is_stuck_state_auth_required_long():
    assert is_stuck_state("auth-required", A2A_INPUT_REQUIRED_THRESHOLD_S + 1)


# ── Memory detectors ────────────────────────────────────────────


def test_memory_bloat_alert():
    alerts = detect_memory_bloat({"u1": 5000, "u2": 12000, "u3": 20000})
    assert len(alerts) == 2
    assert any(a.user_id == "u2" and a.severity == "warn" for a in alerts)
    assert any(a.user_id == "u3" and a.severity == "alert" for a in alerts)


def test_memory_bloat_no_alerts():
    assert detect_memory_bloat({"u1": 1000, "u2": 5000}) == []


def test_memory_conflict_negation_mismatch():
    """Two memories with similar content but opposite polarity → conflict."""
    memories = {
        "u1": [
            "User prefers email notifications",
            "User does not prefer email notifications",
        ]
    }
    conflicts = detect_memory_conflicts(memories, jaccard_threshold=0.3)
    assert len(conflicts) == 1
    assert isinstance(conflicts[0], MemoryConflict)


def test_memory_conflict_no_negation():
    """Two memories agreeing → no conflict."""
    memories = {
        "u1": [
            "User prefers email",
            "User likes email notifications",
        ]
    }
    conflicts = detect_memory_conflicts(memories)
    assert len(conflicts) == 0


def test_memory_conflict_low_overlap_no_conflict():
    memories = {
        "u1": [
            "User prefers email notifications",
            "User likes dark mode",
        ]
    }
    conflicts = detect_memory_conflicts(memories)
    assert len(conflicts) == 0


def test_memory_paging_pressure_high():
    assert detect_memory_paging_pressure(archival_reads=100, core_reads=5)


def test_memory_paging_pressure_normal():
    assert not detect_memory_paging_pressure(archival_reads=10, core_reads=5)


def test_memory_paging_pressure_zero_core():
    assert detect_memory_paging_pressure(archival_reads=1, core_reads=0)


# ── Multi-agent topology ──────────────────────────────────────


def test_agent_depth_runaway_detects_deep():
    depths = {
        "t1": ("a1", None, 3),
        "t2": ("a2", "a1", 7),
        "t3": ("a3", "a2", 12),
    }
    alerts = detect_agent_depth_runaway(depths, threshold=5)
    assert len(alerts) == 2
    assert all(isinstance(a, DepthAlert) for a in alerts)


def test_blackboard_stale_detects_old_writes():
    stale = detect_blackboard_stale(
        last_write_at_by_context={"ctx1": 100.0, "ctx2": 200.0},
        current_time=300.0,
    )
    # Both ctx1 (200s elapsed) and ctx2 (100s elapsed) are >60s old
    assert len(stale) == 2
    assert all(isinstance(s, BlackboardStale) for s in stale)
    assert {s.context_id for s in stale} == {"ctx1", "ctx2"}


def test_blackboard_stale_filters_by_threshold():
    """Only contexts exceeding the threshold appear in results."""
    stale = detect_blackboard_stale(
        last_write_at_by_context={
            "ctx_old": 100.0,    # 200s elapsed > 60
            "ctx_fresh": 280.0,  # 20s elapsed < 60
        },
        current_time=300.0,
    )
    assert len(stale) == 1
    assert stale[0].context_id == "ctx_old"


def test_blackboard_stale_no_alerts():
    assert detect_blackboard_stale({"ctx1": 295.0}, current_time=300.0) == []


def test_swarm_topology_centralized():
    alert = detect_swarm_topology({"p1": 100, "p2": 1, "p3": 1})
    assert alert.classification == "centralized"
    assert alert.entropy_bits < 1.5


def test_swarm_topology_balanced():
    alert = detect_swarm_topology({"p1": 20, "p2": 22, "p3": 18, "p4": 21})
    assert alert.classification == "balanced"
    assert 1.5 <= alert.entropy_bits <= 4.0


def test_swarm_topology_dispersed():
    alert = detect_swarm_topology({f"p{i}": 1 for i in range(50)})
    assert alert.classification == "dispersed"
    assert alert.entropy_bits > 4.0


def test_swarm_topology_empty():
    alert = detect_swarm_topology({})
    assert alert.classification == "balanced"
    assert alert.entropy_bits == 0.0


# ── Drift alert emission ─────────────────────────────────────


def test_emit_drift_alert_format():
    alert = emit_drift_alert(
        "memory_bloat",
        severity="high",
        user_id="u1",
        size_bytes=20000,
    )
    assert alert["drift_type"] == "memory_bloat"
    assert alert["severity"] == "high"
    assert alert["context"]["user_id"] == "u1"
    assert alert["context"]["size_bytes"] == 20000


def test_emit_drift_alert_default_severity():
    alert = emit_drift_alert("agent_depth_runaway", trace_id="t1", depth=10)
    assert alert["severity"] == "high"  # default