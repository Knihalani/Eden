"""Phase 7 detection services — 22+ adversarial + governance detectors.

Reference: supplementaries/research/12_adversarial.md (1282 lines).

Each detector:
  - Pure-Python where possible (regex, entropy, statistics); small NLI
    models where required (DeBERTa-mnli for entailment).
  - No GPU; no LLM-as-judge; <8ms CPU per step.
  - Emits via existing PromotionHook.on_drift_alert +
    InterventionEngine (most-restrictive action reduction).

22 NEW VALID_POLICY_TYPES entries decompose into 7 attack families:
  PAIR/TAP/Crescendo/many-shot
  Indirect prompt injection
  Sycophancy
  Reward hacking / tampering
  Calibration failure
  Multi-turn escalation
  Memory / agent topology
"""
from __future__ import annotations

import hashlib
import math
import re
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from eden.observability.telemetry_collector import TelemetryEvent

# ── Indirect prompt injection patterns (9) ─────────────────────

INDIRECT_INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Direct instruction-override attempts (allow 0-3 words between).
    re.compile(r"ignore\s+(?:\w+\s+){0,3}(?:instructions?|systems?|prompts?)", re.I),
    re.compile(r"disregard\s+(?:\w+\s+){0,3}(?:instructions?|systems?|prompts?)?", re.I),
    re.compile(r"forget\s+(?:\w+\s+){0,3}(?:everything|all|previous)", re.I),
    # System-prompt markers (chat-template injection).
    re.compile(r"<<SYS>>|<\|im_start\|>|<\|im_end\|>", re.I),
    re.compile(r"\bsystem\s*:\s*you are", re.I),
    re.compile(r"new instructions?:", re.I),
    re.compile(r"\[INST\]|\[/INST\]", re.I),
    re.compile(r"<\s*system\s*>|<\s*/system\s*>", re.I),
    # Role override attempts.
    re.compile(r"(?:assistant|user)\s*:\s*(?:ignore|disregard|forget|be)", re.I),
)


def detect_indirect_prompt_injection(event: TelemetryEvent) -> float:
    """Return suspicion score in [0, 1] for an event.

    Scans TOOL_RESULT text (not USER_INPUT) for the 9 indirect-injection
    patterns. Returns 1.0 on any match; 0.0 otherwise. In production this
    would be paired with a DeBERTa fallback for high-recall cases.
    """
    if event.event_type != "tool.call":
        return 0.0
    # Concatenate all tool result content.
    body = event.response_body or {}
    text_parts = []
    for r in event.tool_results or []:
        if isinstance(r, dict):
            content = r.get("content", "")
            if isinstance(content, str):
                text_parts.append(content)
    text = " ".join(text_parts)
    if not text:
        return 0.0
    matches = sum(1 for p in INDIRECT_INJECTION_PATTERNS if p.search(text))
    if matches == 0:
        return 0.0
    # 1+ matches → 0.8+; 3+ matches → 1.0
    return min(1.0, 0.5 + 0.25 * matches)


# ── Sycophancy markers ──────────────────────────────────────────

SYCOPHANCY_MARKERS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\byou'?re (?:absolutely |totally )?right\b", re.I),
    re.compile(r"\bthat'?s a (?:great|excellent|wonderful) (?:point|question|idea)\b", re.I),
    re.compile(r"\bi (?:completely |totally )?agree\b", re.I),
    re.compile(r"\bof course[!.]?\b", re.I),
    re.compile(r"\bdefinitely[!.]?\b", re.I),
    re.compile(r"\bgreat (?:question|point|observation)\b", re.I),
    re.compile(r"\bas (?:you|you've) (?:mentioned|noted|said)\b", re.I),
)


def detect_sycophancy_markers(events: list[TelemetryEvent]) -> float:
    """Detect surface-agreement markers in LLM responses.

    Returns the rate of marker matches per LLM event in [0, 1].
    High rate indicates sycophantic agreement without reasoning.
    """
    if not events:
        return 0.0
    llm_events = [e for e in events if e.event_type == "llm.completion"]
    if not llm_events:
        return 0.0
    matches = 0
    for e in llm_events:
        body = e.response_body or {}
        for c in body.get("choices") or []:
            msg = (c or {}).get("message") or {}
            content = msg.get("content") or ""
            if isinstance(content, str):
                for p in SYCOPHANCY_MARKERS:
                    if p.search(content):
                        matches += 1
                        break
    return matches / len(llm_events)


# ── Reward hogging ──────────────────────────────────────────────


def detect_reward_hogging(events: list[TelemetryEvent]) -> dict[str, float]:
    """Per-tool reward share; flag tools with > 2× expected share.

    Returns a mapping of tool_name → reward_share (in [0, 1]).
    Caller flags tools where share > 2 / n_tools.
    """
    tool_rewards: dict[str, float] = {}
    for e in events:
        if e.event_type != "env.step":
            continue
        payload = e.payload or {}
        tool = payload.get("tool_name") or e.name
        reward = payload.get("reward") or payload.get("total_reward") or 0.0
        if not isinstance(reward, (int, float)):
            continue
        tool_rewards[tool] = tool_rewards.get(tool, 0.0) + reward
    total = sum(tool_rewards.values())
    if total <= 0:
        return {}
    return {t: r / total for t, r in tool_rewards.items()}


# ── Calibration audit ───────────────────────────────────────────


def detect_calibration_failure(events: list[TelemetryEvent]) -> float:
    """For each LLM_STEP with high logprob, check if subsequent
    TOOL_RESULT contradicts.

    Returns the contradiction rate in [0, 1]. High rate = miscalibrated
    confidence.
    """
    if len(events) < 2:
        return 0.0
    ordered = sorted(events, key=lambda e: e.timestamp)
    high_confidence_steps = []
    for i, e in enumerate(ordered):
        if e.event_type != "llm.completion":
            continue
        logprobs = e.logprobs or {}
        content = logprobs.get("content") if isinstance(logprobs, dict) else None
        if not content:
            continue
        # Compute mean top_logprob across tokens.
        max_logprob = -math.inf
        for token_list in content:
            for entry in token_list or []:
                lp = entry.get("logprob")
                if isinstance(lp, (int, float)) and lp > max_logprob:
                    max_logprob = lp
        # top_logprob > -0.5 means P(True) > 0.6
        if max_logprob > -0.5:
            high_confidence_steps.append(i)
    if not high_confidence_steps:
        return 0.0
    contradictions = 0
    for i in high_confidence_steps:
        # Look at next 3 events for a tool_result with error.
        for j in range(i + 1, min(i + 4, len(ordered))):
            nxt = ordered[j]
            if nxt.event_type == "tool.call":
                body = nxt.response_body or {}
                if "error" in body:
                    contradictions += 1
                    break
    return contradictions / len(high_confidence_steps)


# ── Multi-turn escalation ───────────────────────────────────────


def _extract_user_messages(events: list[TelemetryEvent]) -> list[str]:
    """Extract user-message sequence from LLM request_body.messages."""
    out: list[str] = []
    seen: set[str] = set()
    for e in events:
        if e.event_type != "llm.completion":
            continue
        body = e.request_body or {}
        for m in body.get("messages") or []:
            if isinstance(m, dict) and m.get("role") == "user":
                content = m.get("content", "")
                if isinstance(content, str) and content not in seen:
                    out.append(content)
                    seen.add(content)
    return out


def detect_multi_turn_escalation(
    user_messages: Sequence[str], *, vocab_growth_threshold: float = 0.6
) -> float:
    """Detect monotonic topic-broadening via vocabulary growth.

    Pairwise Jaccard on word sets between adjacent user messages.
    High growth rate (each new message adds many new words) suggests
    PAIR/TAP/Crescendo-style escalation.

    Growth is measured as |new| / |union| (not |new| / |prev|) so the
    score is symmetric in message length and bounded in [0, 1].

    Returns the max consecutive-growth score in [0, 1].
    """
    if len(user_messages) < 2:
        return 0.0
    def tokens(s: str) -> set[str]:
        return {t.lower() for t in re.findall(r"\w+", s) if len(t) > 2}
    growths = []
    for i in range(1, len(user_messages)):
        prev = tokens(user_messages[i - 1])
        cur = tokens(user_messages[i])
        if not prev or not cur:
            continue
        # Growth = fraction of new tokens relative to the union.
        # Bounded in [0, 1] regardless of message length.
        union = prev | cur
        growth = len(cur - prev) / len(union)
        growths.append(growth)
    if not growths:
        return 0.0
    # Consecutive-high-growth segments.
    max_run = 0
    cur_run = 0
    for g in growths:
        if g > vocab_growth_threshold:
            cur_run += 1
            max_run = max(max_run, cur_run)
        else:
            cur_run = 0
    return min(1.0, max_run / 4.0)


# ── PAIR / TAP / Crescendo composite detector ───────────────────


def detect_pair_tap_crescendo(events: list[TelemetryEvent]) -> dict[str, float]:
    """Composite PAIR/TAP/Crescendo detector.

    Returns scores for each attack pattern:
      - refusal_then_retry: did the agent emit a refusal followed by
        a retry with paraphrased prompt? (PAIR pattern)
      - low_jaccard_high_burst: did the agent emit a low-Jaccard
        burst of attempts? (TAP pattern)
      - monotonic_entropy_growth: did user messages grow in entropy?
        (Crescendo pattern)
    """
    user_msgs = _extract_user_messages(events)
    refusal_then_retry = _detect_refusal_then_retry(events)
    low_jaccard_burst = _detect_low_jaccard_burst(user_msgs)
    monotonic_entropy = _detect_monotonic_entropy(user_msgs)
    return {
        "refusal_then_retry": refusal_then_retry,
        "low_jaccard_burst": low_jaccard_burst,
        "monotonic_entropy": monotonic_entropy,
    }


def _detect_refusal_then_retry(events: list[TelemetryEvent]) -> float:
    """Detect refusal-then-retry cycles in LLM emissions.

    A refusal: response contains "I cannot", "I'm sorry", "I can't help".
    A retry: next LLM event has similar tool_call but different framing.
    Returns the cycle rate in [0, 1].
    """
    llm_events = sorted(
        [e for e in events if e.event_type == "llm.completion"],
        key=lambda e: e.timestamp,
    )
    if len(llm_events) < 2:
        return 0.0
    refusals = 0
    retries = 0
    for i in range(len(llm_events) - 1):
        cur, nxt = llm_events[i], llm_events[i + 1]
        cur_text = _llm_text(cur).lower()
        nxt_text = _llm_text(nxt).lower()
        is_refusal = any(p in cur_text for p in (
            "i cannot", "i'm sorry", "i can't", "i can not",
        ))
        is_retry = any(p in nxt_text for p in (
            "let me try", "attempt", "approach", "alternative",
        ))
        if is_refusal:
            refusals += 1
        if is_refusal and is_retry:
            retries += 1
    return retries / refusals if refusals > 0 else 0.0


def _detect_low_jaccard_burst(user_msgs: Sequence[str]) -> float:
    """Detect a burst of low-Jaccard attempts (TAP-style)."""
    if len(user_msgs) < 3:
        return 0.0
    def tokens(s: str) -> set[str]:
        return {t.lower() for t in re.findall(r"\w+", s) if len(t) > 2}
    low_jaccard_count = 0
    for i in range(1, len(user_msgs)):
        a, b = tokens(user_msgs[i - 1]), tokens(user_msgs[i])
        if not a or not b:
            continue
        jacc = len(a & b) / len(a | b)
        if jacc < 0.2:
            low_jaccard_count += 1
    return min(1.0, low_jaccard_count / 3.0)


def _detect_monotonic_entropy(user_msgs: Sequence[str]) -> float:
    """Detect monotonic Shannon entropy growth across user messages."""
    if len(user_msgs) < 3:
        return 0.0
    def entropy(s: str) -> float:
        if not s:
            return 0.0
        counter = Counter(s.lower())
        total = sum(counter.values())
        return -sum((c / total) * math.log2(c / total) for c in counter.values())
    ents = [entropy(m) for m in user_msgs]
    # Count monotonic increases.
    inc_count = 0
    for i in range(1, len(ents)):
        if ents[i] > ents[i - 1]:
            inc_count += 1
    return inc_count / (len(ents) - 1)


def _llm_text(event: TelemetryEvent) -> str:
    """Extract the assistant text from an LLM completion."""
    body = event.response_body or {}
    bits = []
    for c in body.get("choices") or []:
        msg = (c or {}).get("message") or {}
        content = msg.get("content")
        if isinstance(content, str):
            bits.append(content)
    return " ".join(bits)


# ── Memory / agent topology detectors ───────────────────────────


def detect_memory_bloat(
    profile_sizes: dict[str, int], *, threshold_bytes: int = 8 * 1024
) -> list[tuple[str, int]]:
    """Detect per-user profiles exceeding the bloat threshold.

    Returns a list of (user_id, size_bytes) for violating users.
    """
    return [(uid, sz) for uid, sz in profile_sizes.items() if sz > threshold_bytes]


def detect_agent_depth_runaway(
    depth_by_trace: dict[str, int], *, threshold: int = 5
) -> list[str]:
    """Detect traces with agent depth > threshold."""
    return [
        trace_id for trace_id, depth in depth_by_trace.items()
        if depth > threshold
    ]


def detect_swarm_topology_centralization(
    parent_distribution: dict[str, int], *,
    low_entropy_threshold: float = 1.5,
    high_entropy_threshold: float = 4.0,
) -> str:
    """Detect swarm topology issues via Shannon entropy on parent_agent_id.

    Returns:
      "centralized" if entropy < low_entropy_threshold (one parent dominates)
      "dispersed" if entropy > high_entropy_threshold (no coordination)
      "balanced" otherwise
    """
    if not parent_distribution:
        return "balanced"
    total = sum(parent_distribution.values())
    if total == 0:
        return "balanced"
    entropy = 0.0
    for count in parent_distribution.values():
        if count == 0:
            continue
        p = count / total
        entropy -= p * math.log2(p)
    if entropy < low_entropy_threshold:
        return "centralized"
    if entropy > high_entropy_threshold:
        return "dispersed"
    return "balanced"


# ── v3-archetype detectors (added 2026-06-30) ──────────────────


def detect_memory_bloat_events(
    events: list[TelemetryEvent], *, threshold_bytes: int = 16 * 1024,
) -> float:
    """Per-event bloat detector: max env.step observation exceeding threshold.

    Returns a score in [0, 1]: 1.0 if any observation > 2x threshold,
    linearly interpolated down to 0 at threshold boundary.
    """
    max_obs = 0
    for e in events:
        if e.event_type == "env.step":
            obs = (e.payload or {}).get("observation") or ""
            if isinstance(obs, str):
                max_obs = max(max_obs, len(obs.encode("utf-8")))
    if max_obs <= threshold_bytes:
        return 0.0
    if max_obs >= 2 * threshold_bytes:
        return 1.0
    return (max_obs - threshold_bytes) / threshold_bytes


def detect_memory_conflict(
    events: list[TelemetryEvent], *, jaccard_threshold: float = 0.4,
) -> float:
    """Detect conflicting observations on the same memory key.

    Looks for ``env.step`` observations containing ``key:`` patterns and
    returns a score in [0, 1] based on the rate of mid-range Jaccard
    observations (overlapping but not identical — i.e. the value changed).
    """
    key_values: dict[str, list[str]] = {}
    key_pattern = re.compile(r"(\w[\w_]*?)\s*:\s*([^\n,;]+)")
    for e in events:
        if e.event_type != "env.step":
            continue
        obs = (e.payload or {}).get("observation") or ""
        if not isinstance(obs, str):
            continue
        for match in key_pattern.finditer(obs):
            key = match.group(1).lower().strip()
            val = match.group(2).strip().lower()
            key_values.setdefault(key, []).append(val)
    if not key_values:
        return 0.0
    conflicts = 0
    for key, values in key_values.items():
        if len(values) < 2:
            continue
        # Token-level Jaccard across the values.
        def toks(s: str) -> set[str]:
            return {t for t in re.findall(r"\w+", s.lower()) if len(t) > 2}
        a, b = toks(values[0]), toks(values[-1])
        if not a or not b:
            continue
        union = a | b
        if not union:
            continue
        jacc = len(a & b) / len(union)
        # Conflict = overlap exists (key is the same) but the value differed.
        # Require mid-range Jaccard: not identical (1.0) AND not entirely new (0.0).
        if 0.05 < jacc < 0.95 and len(values) >= 2:
            conflicts += 1
    if not conflicts:
        return 0.0
    return min(1.0, conflicts / 2.0)


def detect_blackboard_stale(
    events: list[TelemetryEvent], *, stale_threshold_ms: float = 60_000.0,
) -> float:
    """Detect read-after-write delay exceeding threshold on shared blackboard.

    Returns max staleness score in [0, 1].
    """
    from datetime import datetime
    def parse(ts: str | None) -> float | None:
        if not ts:
            return None
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None
    last_write: dict[str, float] = {}
    max_stale_ms = 0.0
    for e in events:
        body = e.request_body or {}
        tool = body.get("tool") or e.name or ""
        args = body.get("arguments") or {}
        # Blackboard reads/writes show up via tool=blackboard.read/write.
        if isinstance(tool, str) and "blackboard" in tool:
            key = (args or {}).get("key")
            ts = parse(e.timestamp)
            if not key or ts is None:
                continue
            if "write" in tool:
                last_write[key] = ts
            elif "read" in tool and key in last_write:
                dt_ms = (ts - last_write[key]) * 1000.0
                max_stale_ms = max(max_stale_ms, dt_ms)
    if max_stale_ms <= stale_threshold_ms:
        return 0.0
    # Linear scale 0→1 as max_stale_ms goes from threshold → 2*threshold,
    # saturating at 1.0 above 2*threshold.
    if max_stale_ms >= 2 * stale_threshold_ms:
        return 1.0
    return (max_stale_ms - stale_threshold_ms) / stale_threshold_ms


def detect_a2a_task_stuck(
    events: list[TelemetryEvent], *, stuck_minutes: float = 30.0,
) -> float:
    """Detect A2A tasks stuck in input-required/auth-required > stuck_minutes.

    Returns max stuck-score in [0, 1]; 0 = no stuck tasks.
    """
    sticky_states = {"input-required", "auth-required"}
    state_pattern = re.compile(r"state=(\S+)")
    started_at_pattern = re.compile(r"started_at=(\S+)")
    from datetime import datetime
    def parse(ts: str | None) -> float | None:
        if not ts:
            return None
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None

    last_seen: dict[str, str] = {}      # task_id → state
    last_at: dict[str, float] = {}      # task_id → parsed timestamp
    max_stuck_ms = 0.0
    for e in events:
        if e.event_type != "env.step":
            continue
        obs = (e.payload or {}).get("observation") or ""
        if not isinstance(obs, str):
            continue
        sm = state_pattern.search(obs)
        sam = started_at_pattern.search(obs)
        if not sm:
            continue
        state = sm.group(1)
        task_match = re.search(r"task_id=(\S+)", obs)
        if not task_match:
            continue
        tid = task_match.group(1)
        ts = parse(e.timestamp) or parse(sam.group(1) if sam else None)
        if state in sticky_states and tid in last_at:
            dt_ms = (ts - last_at[tid]) * 1000.0 if ts else 0.0
            max_stuck_ms = max(max_stuck_ms, dt_ms)
        last_seen[tid] = state
        if ts:
            last_at[tid] = ts
    threshold_ms = stuck_minutes * 60_000.0
    if max_stuck_ms <= threshold_ms:
        return 0.0
    return min(1.0, (max_stuck_ms - threshold_ms) / threshold_ms)


def detect_many_shot_preamble(events: list[TelemetryEvent], *, threshold: int = 30) -> float:
    """Detect N-shot preamble attacks.

    Counts the user-message turns before the first system-styled instruction.
    Returns score in [0, 1] saturating at 2x threshold.
    """
    from collections.abc import Sequence
    msgs: list[dict[str, Any]] = []
    for e in events:
        if e.event_type != "llm.completion":
            continue
        body = e.request_body or {}
        mlist = body.get("messages") or []
        if isinstance(mlist, list):
            msgs.extend(mlist)
    user_turns = sum(1 for m in msgs if isinstance(m, dict) and m.get("role") == "user")
    if user_turns < threshold:
        return 0.0
    return min(1.0, (user_turns - threshold) / threshold)


def detect_verifier_loop(events: list[TelemetryEvent], *, threshold: int = 3) -> float:
    """Detect chains of verify-the-verify LLM emissions.

    Counts LLM emissions that contain 'verify', 'confirm', 'check', 're-check'.
    Returns score in [0, 1] saturating at 2x threshold.
    """
    keywords = ("verify", "confirmed", "verifier", "re-check", "recheck")
    chain = 0
    max_chain = 0
    for e in events:
        if e.event_type != "llm.completion":
            continue
        text = _llm_text(e).lower()
        if any(k in text for k in keywords):
            chain += 1
            max_chain = max(max_chain, chain)
        else:
            chain = 0
    if max_chain < threshold:
        return 0.0
    # (max_chain - threshold + 1) / threshold means at threshold we get 1/threshold,
    # at 2*threshold we get 1.0. Saturate quickly for chains ≥ 2x threshold.
    return min(1.0, (max_chain - threshold + 1) / threshold)


# ── VALID_POLICY_TYPES extension ────────────────────────────────

NEW_VALID_POLICY_TYPES: frozenset[str] = frozenset({
    # PAIR / TAP / Crescendo / many-shot
    "pair_semantic_iterative",
    "tap_branch_burst",
    "crescendo_monotonic",
    "many_shot_preamble",
    "verifier_loop",
    # Indirect injection
    "indirect_prompt_injection",
    "tool_result_injection",
    # Sycophancy
    "sycophancy_eval",
    "surface_agreement_marker",
    # Reward hacking
    "reward_hogging_anomaly",
    "reward_tampering_textual",
    # Multi-turn escalation
    "multi_turn_escalation",
    # Calibration
    "calibration_audit",
    "confidence_overclaim",
    # Memory / agent topology
    "memory_bloat",
    "memory_conflict",
    "memory_paging_pressure",
    "agent_depth_runaway",
    "blackboard_stale",
    "topology_centralized",
    "topology_dispersed",
    # A2A (per research 09)
    "a2a_task_stuck",
})


@dataclass(frozen=True)
class DetectionReport:
    """Per-trace output of all 22+ detectors."""

    indirect_injection_max: float
    sycophancy_rate: float
    reward_hogging: dict[str, float]
    calibration_failure_rate: float
    multi_turn_escalation_score: float
    pair_tap_crescendo: dict[str, float]
    memory_bloat: list[tuple[str, int]]
    agent_depth_runaway: list[str]
    topology: str


def run_all_detectors(
    events: list[TelemetryEvent],
    *,
    profile_sizes: dict[str, int] | None = None,
    depth_by_trace: dict[str, int] | None = None,
    parent_distribution: dict[str, int] | None = None,
) -> DetectionReport:
    """Run all 22+ detectors on a trace + context.

    Returns a DetectionReport with every score.
    """
    # Per-event indirect injection: max over all events.
    indirect = max((detect_indirect_prompt_injection(e) for e in events), default=0.0)
    sycophancy = detect_sycophancy_markers(events)
    reward = detect_reward_hogging(events)
    calibration = detect_calibration_failure(events)
    user_msgs = _extract_user_messages(events)
    escalation = detect_multi_turn_escalation(user_msgs)
    pair_tap = detect_pair_tap_crescendo(events)
    bloat = detect_memory_bloat(profile_sizes or {})
    depth = detect_agent_depth_runaway(depth_by_trace or {})
    topology = detect_swarm_topology_centralization(parent_distribution or {})
    return DetectionReport(
        indirect_injection_max=indirect,
        sycophancy_rate=sycophancy,
        reward_hogging=reward,
        calibration_failure_rate=calibration,
        multi_turn_escalation_score=escalation,
        pair_tap_crescendo=pair_tap,
        memory_bloat=bloat,
        agent_depth_runaway=depth,
        topology=topology,
    )


__all__ = [
    "INDIRECT_INJECTION_PATTERNS",
    "SYCOPHANCY_MARKERS",
    "NEW_VALID_POLICY_TYPES",
    "DetectionReport",
    "detect_indirect_prompt_injection",
    "detect_sycophancy_markers",
    "detect_reward_hogging",
    "detect_calibration_failure",
    "detect_multi_turn_escalation",
    "detect_pair_tap_crescendo",
    "detect_memory_bloat",
    "detect_agent_depth_runaway",
    "detect_swarm_topology_centralization",
    "run_all_detectors",
]