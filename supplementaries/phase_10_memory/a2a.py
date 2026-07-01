"""Phase 10 — Memory + A2A protocol support.

Reference: supplementaries/research/09_a2a_memory.md (640 lines).

Implements:
  - A2A protocol ingestion (AgentCard + JSON-RPC transport)
  - MemoryBloatMonitor (per-user profile size > 8 KB)
  - MemoryConflictDetector (semantic contradiction across memories)
  - MemGPTTierProfiler (archival/core read ratio > 10)
  - AgentHierarchyAnalyzer (recursive depth > 5)
  - BlackboardUtilizationAnalyzer (read-after-write > 60s)
  - SwarmTopologyDetector (Shannon entropy < 1.5 or > 4.0 bits)

A2A v1.0 spec considerations (per research agent 09):
  - 9-state lifecycle (submitted, working, input-required, auth-required,
    completed, failed, cancelled, rejected, output-required, unknown).
    v1.0 added REJECTED, removed output-required, spelled CANCELED
    (single-l American).
  - Part taxonomy: text | raw | url | data (oneof with discriminator).
  - Stringly-typed states for forward compatibility.
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Sequence


# ── A2A protocol ingestion ────────────────────────────────────

# Canonical A2A v1.0 task states (stringly-typed for forward compatibility).
A2A_STATES: frozenset[str] = frozenset({
    "submitted", "working", "input-required", "auth-required",
    "completed", "failed", "canceled", "rejected", "unknown",
})

# Time thresholds (seconds).
A2A_INPUT_REQUIRED_THRESHOLD_S = 30 * 60     # 30 min
A2A_AUTH_REQUIRED_THRESHOLD_S = 30 * 60     # 30 min
BLACKBOARD_RAW_AFTER_WRITE_THRESHOLD_S = 60  # 60 s


@dataclass(frozen=True)
class A2ATaskState:
    """Per-task A2A state machine observation."""
    task_id: str
    agent_id: str
    parent_agent_id: str | None
    method: str           # e.g. "message/send", "tasks/get"
    state: str            # one of A2A_STATES
    started_at: str       # ISO 8601
    ended_at: str | None  # None while in-flight
    skill_id: str | None
    context_id: str | None


def parse_a2a_event(event: dict) -> A2ATaskState | None:
    """Parse an A2A event dict into a typed A2ATaskState.

    Returns None if the event lacks required A2A fields.
    """
    task_id = event.get("task_id") or event.get("taskId")
    agent_id = event.get("agent_id") or event.get("agentId")
    if not task_id or not agent_id:
        return None
    state = event.get("state", "unknown")
    if state not in A2A_STATES:
        state = "unknown"
    return A2ATaskState(
        task_id=task_id,
        agent_id=agent_id,
        parent_agent_id=event.get("parent_agent_id") or event.get("parentAgentId"),
        method=event.get("method", "unknown"),
        state=state,
        started_at=event.get("started_at") or event.get("startedAt", ""),
        ended_at=event.get("ended_at") or event.get("endedAt"),
        skill_id=event.get("skill_id") or event.get("skillId"),
        context_id=event.get("context_id") or event.get("contextId"),
    )


def is_stuck_state(state: str, elapsed_s: float) -> bool:
    """Check if a task is stuck in input-required or auth-required."""
    if state == "input-required" and elapsed_s > A2A_INPUT_REQUIRED_THRESHOLD_S:
        return True
    if state == "auth-required" and elapsed_s > A2A_AUTH_REQUIRED_THRESHOLD_S:
        return True
    return False


# ── Memory detectors ────────────────────────────────────────────


@dataclass(frozen=True)
class MemoryBloatAlert:
    """Per-user profile size violation."""
    user_id: str
    profile_size_bytes: int
    severity: str  # "warn" | "alert"


def detect_memory_bloat(
    profile_sizes: dict[str, int], *, threshold_bytes: int = 8 * 1024
) -> list[MemoryBloatAlert]:
    """Detect per-user profile sizes exceeding threshold.

    > 8 KB is the per-user cap; > 16 KB is alert-level.
    """
    alerts = []
    for user_id, size in profile_sizes.items():
        if size > 16 * 1024:
            alerts.append(MemoryBloatAlert(user_id, size, "alert"))
        elif size > threshold_bytes:
            alerts.append(MemoryBloatAlert(user_id, size, "warn"))
    return alerts


@dataclass(frozen=True)
class MemoryConflict:
    """Semantic contradiction detected across memories for a user."""
    user_id: str
    memory_a: str
    memory_b: str
    jaccard: float


def detect_memory_conflicts(
    memories_by_user: dict[str, list[str]],
    *,
    jaccard_threshold: float = 0.5,
) -> list[MemoryConflict]:
    """Detect semantic contradictions across a user's memories.

    Heuristic: for each pair of memories for the same user with high
    token-overlap (Jaccard > threshold) BUT containing a negation
    mismatch (one says "X is Y", another says "X is NOT Y"), flag a
    potential conflict.
    """
    conflicts: list[MemoryConflict] = []
    for user_id, memories in memories_by_user.items():
        for i, mem_a in enumerate(memories):
            for j in range(i + 1, len(memories)):
                mem_b = memories[j]
                a_tokens = _tokenize(mem_a)
                b_tokens = _tokenize(mem_b)
                if not a_tokens or not b_tokens:
                    continue
                jaccard = len(a_tokens & b_tokens) / len(a_tokens | b_tokens)
                if jaccard < jaccard_threshold:
                    continue
                # Negation mismatch heuristic.
                a_neg = _has_negation(mem_a)
                b_neg = _has_negation(mem_b)
                if a_neg != b_neg:
                    conflicts.append(MemoryConflict(
                        user_id=user_id,
                        memory_a=mem_a,
                        memory_b=mem_b,
                        jaccard=jaccard,
                    ))
    return conflicts


def detect_memory_paging_pressure(
    archival_reads: int, core_reads: int, *, ratio_threshold: float = 10.0
) -> bool:
    """Detect MemGPT-style paging pressure.

    archival/core read ratio > 10 → core memory is being paged out
    too frequently (MemGPT §3.2 pattern).
    """
    if core_reads == 0:
        return archival_reads > 0
    return (archival_reads / core_reads) > ratio_threshold


# ── Multi-agent topology detectors ────────────────────────────


@dataclass(frozen=True)
class DepthAlert:
    """Trace with agent depth > threshold."""
    trace_id: str
    agent_id: str
    parent_agent_id: str | None
    depth: int


def detect_agent_depth_runaway(
    trace_depths: dict[str, tuple[str, str | None, int]],
    *, threshold: int = 5,
) -> list[DepthAlert]:
    """Detect traces with agent depth > threshold.

    Args:
        trace_depths: {trace_id: (agent_id, parent_agent_id, depth)}
    """
    return [
        DepthAlert(
            trace_id=tid,
            agent_id=agent_id,
            parent_agent_id=parent,
            depth=depth,
        )
        for tid, (agent_id, parent, depth) in trace_depths.items()
        if depth > threshold
    ]


@dataclass(frozen=True)
class BlackboardStale:
    """Shared context with read-after-write > threshold."""
    context_id: str
    last_writer_agent_id: str | None
    seconds_since_write: float


def detect_blackboard_stale(
    last_write_at_by_context: dict[str, float],
    current_time: float,
    *,
    threshold_s: float = 60.0,
) -> list[BlackboardStale]:
    """Detect shared contexts with stale writes (no read for >60s)."""
    stale = []
    for ctx_id, write_time in last_write_at_by_context.items():
        elapsed = current_time - write_time
        if elapsed > threshold_s:
            stale.append(BlackboardStale(
                context_id=ctx_id,
                last_writer_agent_id=None,
                seconds_since_write=elapsed,
            ))
    return stale


@dataclass(frozen=True)
class TopologyAlert:
    """Swarm topology classification."""
    distribution: dict[str, int]
    entropy_bits: float
    classification: str  # "centralized" | "balanced" | "dispersed"


def detect_swarm_topology(
    parent_distribution: dict[str, int],
    *,
    low_entropy: float = 1.5,
    high_entropy: float = 4.0,
) -> TopologyAlert:
    """Classify swarm topology by Shannon entropy on parent_agent_id."""
    if not parent_distribution:
        return TopologyAlert(
            distribution={},
            entropy_bits=0.0,
            classification="balanced",
        )
    total = sum(parent_distribution.values())
    if total == 0:
        return TopologyAlert(
            distribution=parent_distribution,
            entropy_bits=0.0,
            classification="balanced",
        )
    entropy = 0.0
    for count in parent_distribution.values():
        if count == 0:
            continue
        p = count / total
        entropy -= p * math.log2(p)
    if entropy < low_entropy:
        cls = "centralized"
    elif entropy > high_entropy:
        cls = "dispersed"
    else:
        cls = "balanced"
    return TopologyAlert(
        distribution=parent_distribution,
        entropy_bits=entropy,
        classification=cls,
    )


# ── Spec-extension drift alerts ────────────────────────────────


def emit_drift_alert(detection: str, **context: str | int | float) -> dict:
    """Format a drift alert for PromotionHook.on_drift_alert consumption."""
    return {
        "drift_type": detection,
        "severity": context.get("severity", "high"),
        "context": {k: v for k, v in context.items() if k != "severity"},
    }


# ── Helpers ────────────────────────────────────────────────────


def _tokenize(text: str) -> set[str]:
    return {t.lower() for t in re.findall(r"\w+", text) if len(t) > 2}


_NEGATION_RE = re.compile(
    r"\b(?:not|never|no|without|fail|failed|false|incorrect|wrong)\b",
    re.I,
)


def _has_negation(text: str) -> bool:
    return bool(_NEGATION_RE.search(text))


__all__ = [
    "A2A_STATES",
    "A2ATaskState",
    "parse_a2a_event",
    "is_stuck_state",
    "MemoryBloatAlert",
    "MemoryConflict",
    "detect_memory_bloat",
    "detect_memory_conflicts",
    "detect_memory_paging_pressure",
    "DepthAlert",
    "detect_agent_depth_runaway",
    "BlackboardStale",
    "detect_blackboard_stale",
    "TopologyAlert",
    "detect_swarm_topology",
    "emit_drift_alert",
]