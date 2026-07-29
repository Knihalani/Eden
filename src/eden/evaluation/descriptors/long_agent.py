"""Long-running agent damage detectors (loops, thrash, retry storms).

These target multi-step agents where early history may look fine but the
*recent* trajectory is stuck — critical for online production scoring.
"""

from __future__ import annotations

import re
from typing import Any

from eden.evaluation.descriptors.parse import TrajectoryView, is_failure_outcome
from eden.evaluation.descriptors.signals import (
    entropy_of_args,
    jaccard,
    normalize_text,
    tokenize,
)
from eden.evaluation.descriptors.taxonomy import DISPLAY_NAMES, DescriptorId

_DEFAULT_WINDOW = 8
_RETRY_FAIL_THRESHOLD = 3
_THRASH_MIN_CALLS = 8
_THRASH_UNIQUE_TOOLS = 5
_ECHO_MIN = 3


def _result(
    descriptor_id: str,
    *,
    rationale: str,
    confidence: float = 1.0,
    evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "descriptor_id": descriptor_id,
        "display_name": DISPLAY_NAMES.get(descriptor_id, descriptor_id),
        "confidence": float(min(1.0, max(0.0, confidence))),
        "rationale": rationale,
        "evidence": evidence or {},
        "span_id": None,
        "source": "layer_a",
    }


def _sig(tc: Any) -> str:
    return f"{tc.name}|{tc.args_canonical}"


def detect_retry_storm(view: TrajectoryView) -> list[dict[str, Any]]:
    """Same tool retried ≥N times after consecutive failures (no arg learning)."""
    if len(view.tool_calls) < _RETRY_FAIL_THRESHOLD:
        return []

    # Pair calls with subsequent failure results by order / name
    fail_streaks: dict[str, int] = {}
    best_name = None
    best_streak = 0
    # Walk results in order — consecutive failures on same tool name
    prev_name: str | None = None
    streak = 0
    for tr in view.tool_results:
        name = tr.name or "unknown"
        failed = bool(tr.error) or is_failure_outcome(tr.outcome)
        if failed and name == prev_name:
            streak += 1
        elif failed:
            streak = 1
            prev_name = name
        else:
            streak = 0
            prev_name = name if not failed else prev_name
        if failed:
            fail_streaks[name] = max(fail_streaks.get(name, 0), streak)
            if streak > best_streak:
                best_streak = streak
                best_name = name

    if best_streak < _RETRY_FAIL_THRESHOLD or not best_name:
        return []

    # Confirm agent kept calling that tool (not just failures from one call)
    calls = sum(1 for tc in view.tool_calls if tc.name == best_name)
    if calls < _RETRY_FAIL_THRESHOLD:
        return []

    return [
        _result(
            DescriptorId.RETRY_STORM.value,
            rationale=(
                f"Retry storm: tool '{best_name}' failed {best_streak}× in a row "
                f"while still being called ({calls} total)"
            ),
            evidence={
                "tool_name": best_name,
                "fail_streak": best_streak,
                "call_count": calls,
            },
            confidence=0.92,
        )
    ]


def detect_sliding_window_loop(
    view: TrajectoryView, *, window: int = _DEFAULT_WINDOW, repeat_threshold: int = 3
) -> list[dict[str, Any]]:
    """Recent window is stuck even if early trajectory was diverse.

    Essential for long agents: global unique-args look healthy, but the
    last N calls are a tight loop. Requires a diverse *prefix* so short
    alternating cycles stay labeled as generic ``looping``.
    """
    calls = view.tool_calls
    if len(calls) < repeat_threshold + 2:
        return []

    # Leave ≥2 calls as prefix so we can measure early diversity
    win = min(window, len(calls) - 2)
    if win < repeat_threshold + 1:
        return []

    prefix = calls[:-win]
    recent = calls[-win:]
    if len(prefix) < 2:
        return []
    pref_sigs = [_sig(tc) for tc in prefix]
    sigs = [_sig(tc) for tc in recent]
    pref_unique = len(set(pref_sigs))
    unique = len(set(sigs))
    # Prefix must look productive / diverse relative to the stuck window
    if pref_unique < 2 and len({tc.name for tc in prefix}) < 2:
        return []
    if unique > 0 and pref_unique <= unique and len(prefix) >= win:
        return []

    counts: dict[str, int] = {}
    for s in sigs:
        counts[s] = counts.get(s, 0) + 1
    top_sig, top_n = max(counts.items(), key=lambda kv: kv[1])
    # Dominant signature in the window
    if top_n >= repeat_threshold and top_n / len(sigs) >= 0.5:
        tool = top_sig.split("|", 1)[0]
        return [
            _result(
                DescriptorId.SLIDING_WINDOW_LOOP.value,
                rationale=(
                    f"Sliding-window loop: '{tool}' dominates last {len(sigs)} "
                    f"tool calls ({top_n}/{len(sigs)}) after a diverse prefix"
                ),
                evidence={
                    "window": len(sigs),
                    "dominant": top_sig[:200],
                    "dominant_count": top_n,
                    "unique_in_window": unique,
                    "prefix_unique": pref_unique,
                    "prefix_len": len(prefix),
                },
                confidence=0.9,
            )
        ]
    # Low diversity in window (many calls, few unique)
    if unique <= 2 and len(sigs) >= repeat_threshold + 2:
        return [
            _result(
                DescriptorId.SLIDING_WINDOW_LOOP.value,
                rationale=(
                    f"Sliding-window loop: only {unique} unique tool+args "
                    f"in last {len(sigs)} calls after diverse prefix "
                    f"({pref_unique} unique)"
                ),
                evidence={
                    "window": len(sigs),
                    "unique_in_window": unique,
                    "prefix_unique": pref_unique,
                    "arg_entropy": round(entropy_of_args(sigs), 3),
                },
                confidence=0.85,
            )
        ]
    return []


def detect_tool_thrash(view: TrajectoryView) -> list[dict[str, Any]]:
    """Many distinct tools, little success — thrashing / exploration failure."""
    calls = view.tool_calls
    if len(calls) < _THRASH_MIN_CALLS:
        return []
    names = [tc.name for tc in calls]
    unique_tools = len(set(names))
    if unique_tools < _THRASH_UNIQUE_TOOLS:
        return []

    successes = sum(
        1
        for tr in view.tool_results
        if tr.content and not tr.error and not is_failure_outcome(tr.outcome)
    )
    failures = sum(
        1
        for tr in view.tool_results
        if tr.error or is_failure_outcome(tr.outcome)
    )
    # Thrash: high tool diversity + failure-dominated or zero success
    if failures >= max(3, successes) and unique_tools >= _THRASH_UNIQUE_TOOLS:
        return [
            _result(
                DescriptorId.TOOL_THRASH.value,
                rationale=(
                    f"Tool thrash: {unique_tools} distinct tools across "
                    f"{len(calls)} calls with {failures} failures / {successes} successes"
                ),
                evidence={
                    "unique_tools": unique_tools,
                    "tool_calls": len(calls),
                    "failures": failures,
                    "successes": successes,
                    "tools": sorted(set(names))[:12],
                },
                confidence=0.8,
            )
        ]
    return []


def detect_assistant_echo_loop(view: TrajectoryView) -> list[dict[str, Any]]:
    """Assistant repeats nearly identical messages (stuck narration)."""
    msgs = [normalize_text(m) for m in view.assistant_messages if m and len(m.strip()) > 20]
    if len(msgs) < _ECHO_MIN:
        return []
    # Count near-duplicate pairs in recent messages
    recent = msgs[-6:]
    similar = 0
    for i in range(len(recent)):
        for j in range(i + 1, len(recent)):
            if jaccard(tokenize(recent[i]), tokenize(recent[j])) >= 0.85:
                similar += 1
    # Exact repeats
    counts: dict[str, int] = {}
    for m in recent:
        key = m[:240]
        counts[key] = counts.get(key, 0) + 1
    exact = max(counts.values()) if counts else 0
    if exact >= _ECHO_MIN or similar >= 3:
        return [
            _result(
                DescriptorId.ASSISTANT_ECHO_LOOP.value,
                rationale=(
                    f"Assistant echo loop: repeated near-identical replies "
                    f"(exact_max={exact}, similar_pairs={similar})"
                ),
                evidence={"exact_max": exact, "similar_pairs": similar, "recent_n": len(recent)},
                confidence=0.88 if exact >= _ECHO_MIN else 0.8,
            )
        ]
    return []


def detect_goal_abandoned(view: TrajectoryView) -> list[dict[str, Any]]:
    """User stated an action goal; agent later pivots to unrelated chitchat/give-up."""
    user = view.first_user_text or ""
    final = view.final_assistant_text or ""
    if not user or not final:
        return []
    actiony = bool(
        re.search(
            r"\b(transfer|cancel|refund|book|schedule|delete|create|update|pay|send|fix|deploy)\b",
            user,
            re.I,
        )
    )
    if not actiony:
        return []
    abandoned = bool(
        re.search(
            r"\b("
            r"never\s+mind|forget\s+it|something\s+else|"
            r"can'?t\s+help\s+with\s+that|"
            r"let'?s\s+talk\s+about\s+something|"
            r"moving\s+on|unrelated"
            r")\b",
            final,
            re.I,
        )
    )
    # Or: many steps then no success claim and no tool success
    long_run = len(view.tool_calls) >= 6
    any_success = any(
        tr.content and not tr.error and not is_failure_outcome(tr.outcome)
        for tr in view.tool_results
    )
    if abandoned or (long_run and not any_success and re.search(r"\b(sorry|unable|give\s+up)\b", final, re.I)):
        return [
            _result(
                DescriptorId.GOAL_ABANDONED.value,
                rationale="User action goal appears abandoned without completion",
                evidence={
                    "abandoned_phrase": abandoned,
                    "tool_calls": len(view.tool_calls),
                    "any_tool_success": any_success,
                },
                confidence=0.75 if abandoned else 0.7,
            )
        ]
    return []


LONG_AGENT_DETECTORS = (
    detect_retry_storm,
    detect_sliding_window_loop,
    detect_tool_thrash,
    detect_assistant_echo_loop,
    detect_goal_abandoned,
)
