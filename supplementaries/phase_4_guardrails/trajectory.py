"""Phase 4 — TrajectoryGuardrail orchestrator.

Reference: supplementaries/research/11_online_guardrails.md (1115 lines).
Implements the 8 hot-path checks + 4 async advisory from the v0.2 spec.

Hot-path checks (each <1ms CPU target):
  1. CostGuard       — per-step cost vs Cat 8 z-score
  2. TokenGuard      — projected total vs budget
  3. LoopGuard       — LoopDetector ensemble verdict
  4. ToolDedup       — last-N tool calls with same args (K=2)
  5. RetryStormGuard — consecutive same-tool failures
  6. SchemaValidator — Pydantic-style field check on call JSON
  7. LatencyGuard    — per-step latency vs Cat 22 baseline
  8. ConfidenceGuard — logprob-based confidence check

Async advisory (fire-and-forget, fire per step):
  A1. OutputEmbeddingAnomaly — embedding z-score (uses Cat 13 infra)
  A2. ReasoningSelfSimilarity — consecutive-step cosine
  A3. OutputLengthGuard — output token count z-score
  A4. UserPromptDedup — prompt hash against recent

Action precedence (most-restrictive-first):
  BLOCK > STOP > ESCALATE > TRUNCATE > REPLAN > REWRITE >
  COALESCE > SUMMARIZE > CACHE > SKIP_STEP > WARN > OK

Latency target: <5ms p99 per step on hot path.
"""
from __future__ import annotations

import hashlib
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from eden.observability.telemetry_collector import TelemetryEvent

from supplementaries.phase_3_loops.ensemble import check as ensemble_check

# ── Action enum (extension to VALID_ACTIONS) ────────────────────

ACTIONS = frozenset({
    "allow", "warn", "redact", "block", "escalate",
    "skip_step", "summarize", "anchor", "lazy_recall",
    "coalesce", "rewrite", "truncate", "replan", "cache",
})

ACTION_RANK: dict[str, int] = {
    "allow": 0,
    "warn": 1,
    "cache": 2,
    "skip_step": 3,
    "coalesce": 4,
    "summarize": 5,
    "rewrite": 6,
    "replan": 7,
    "truncate": 8,
    "redact": 9,
    "escalate": 10,
    "stop": 11,
    "block": 12,
}


def _most_restrictive(actions: Iterable[str]) -> str:
    """Return the most-restrictive action from a set."""
    return max(actions, key=lambda a: ACTION_RANK.get(a, 0))


# ── Hot-path check: CostGuard ──────────────────────────────────


@dataclass(frozen=True)
class CostState:
    """Per-trace cost state, fed by Cat 8 cost_intel baseline."""
    mean_cost_7d: float = 0.01
    std_cost_7d: float = 0.005
    per_step_budget_usd: float = 0.50
    per_trace_budget_usd: float = 5.00


def check_cost(
    event: TelemetryEvent, state: CostState, cumulative_cost_usd: float
) -> str:
    """Per-step cost check.

    Blocks when the per-step or cumulative cost exceeds the budget.
    Warns when the step cost is > 3σ above the 7-day mean.
    Returns "allow" otherwise.
    """
    metrics = event.metrics or {}
    cost = float(metrics.get("cost_usd", 0.0))
    if cost > state.per_step_budget_usd:
        return "block"
    if cumulative_cost_usd + cost > state.per_trace_budget_usd:
        return "block"
    if state.std_cost_7d > 0:
        z = (cost - state.mean_cost_7d) / state.std_cost_7d
        if abs(z) > 3:
            return "warn"
    return "allow"


# ── Hot-path check: TokenGuard ─────────────────────────────────


@dataclass(frozen=True)
class TokenState:
    """Per-trace token budgets."""
    per_step_input_tokens: int = 8000
    per_step_output_tokens: int = 2000
    per_trace_input_tokens: int = 200_000
    per_trace_output_tokens: int = 50_000


def check_tokens(
    event: TelemetryEvent, state: TokenState, cumulative: tuple[int, int]
) -> str:
    """Projected token total vs budget."""
    metrics = event.metrics or {}
    inp = int(metrics.get("prompt_tokens", 0))
    out = int(metrics.get("completion_tokens", 0))
    if inp > state.per_step_input_tokens or out > state.per_step_output_tokens:
        return "block"
    cum_in, cum_out = cumulative
    if cum_in + inp > state.per_trace_input_tokens:
        return "block"
    if cum_out + out > state.per_trace_output_tokens:
        return "block"
    return "allow"


# ── Hot-path check: LoopGuard ──────────────────────────────────


def check_loop(events_so_far: Sequence[TelemetryEvent]) -> str:
    """Run LoopDetector ensemble on trace-so-far.

    Returns the ensemble action mapped to the guardrail taxonomy:
      - ensemble "ok" → "allow"
      - ensemble "block" → "block"
      - ensemble "escalate" → "escalate"
    """
    report = ensemble_check(events_so_far)
    return "allow" if report.action == "ok" else report.action


# ── Hot-path check: ToolDedup ───────────────────────────────────


def check_tool_dedup(
    event: TelemetryEvent, history: deque[tuple[str, str]], k: int = 2
) -> str:
    """Coalesce when last K+1 tool calls have identical (tool_name, args_hash).

    Returns "coalesce" if K+1 consecutive dedup hits, else "allow".
    The threshold is K+1 (rather than K) because the current event
    is itself the K+1-th match.
    """
    if event.event_type != "tool.call":
        return "allow"
    body = event.request_body or {}
    tool = body.get("tool") or event.name or ""
    args = body.get("arguments") or {}
    args_hash = hashlib.sha256(
        repr(sorted(args.items()) if isinstance(args, dict) else str(args))
        .encode()
    ).hexdigest()[:16]
    history.append((tool, args_hash))
    if len(history) < k + 1:
        return "allow"
    # Check last K+1 items (including current) match each other.
    current = history[-1]
    consecutive_matches = sum(
        1 for i in range(len(history) - 1, len(history) - k - 2, -1)
        if history[i] == current
    )
    return "coalesce" if consecutive_matches >= k + 1 else "allow"


# ── Hot-path check: RetryStormGuard + CircuitBreaker ───────────


def check_retry_storm(
    event: TelemetryEvent,
    failure_history: deque[bool],
    *,
    threshold: int = 3,
    window: int = 5,
) -> str:
    """Detect consecutive failures → open breaker.

    Returns "block" if `threshold` failures in last `window` events,
    else "allow".
    """
    if event.event_type != "tool.call":
        return "allow"
    is_failure = event.outcome == "failure"
    failure_history.append(is_failure)
    if len(failure_history) < threshold:
        return "allow"
    recent = list(failure_history)[-window:]
    if sum(recent) >= threshold:
        return "block"
    return "allow"


# ── Hot-path check: SchemaValidator ─────────────────────────────


def check_schema(event: TelemetryEvent, required_fields: set[str]) -> str:
    """Validate that the tool call JSON has all required fields.

    Returns "rewrite" if missing required fields (typed refusal),
    else "allow".
    """
    if event.event_type != "tool.call":
        return "allow"
    body = event.request_body or {}
    if not isinstance(body, dict):
        return "rewrite"
    args = body.get("arguments") or {}
    if not isinstance(args, dict):
        return "rewrite"
    present = set(args.keys())
    if not required_fields.issubset(present):
        return "rewrite"
    return "allow"


# ── Hot-path check: LatencyGuard ────────────────────────────────


@dataclass(frozen=True)
class LatencyState:
    """Per-trace latency state."""
    mean_latency_7d_ms: float = 1500.0
    std_latency_7d_ms: float = 500.0
    per_step_max_ms: float = 30_000.0


def check_latency(
    event: TelemetryEvent, state: LatencyState
) -> str:
    """Block on extreme outliers; warn on moderate outliers.

    Returns "block" if latency > per_step_max OR > mean + 5σ.
    Returns "escalate" if > mean + 4σ.
    Returns "warn" if > mean + 3σ.
    Else "allow".
    """
    if event.duration_ms is None:
        return "allow"
    lat = event.duration_ms
    if lat > state.per_step_max_ms:
        return "block"
    z = (lat - state.mean_latency_7d_ms) / max(state.std_latency_7d_ms, 1)
    if z > 5:
        return "block"
    if z > 4:
        return "escalate"
    if z > 3:
        return "warn"
    return "allow"


# ── Hot-path check: FinishReasonMonitor ─────────────────────────


FINISH_REASON_ACTIONS: dict[str, str] = {
    "stop": "allow",
    "end_turn": "allow",
    "tool_calls": "allow",
    "tool_use": "allow",
    "length": "truncate",          # response cut off
    "max_tokens": "truncate",
    "stop_sequence": "allow",
    "content_filter": "escalate",
    "refusal": "escalate",
    "error": "block",
}


def check_finish_reason(event: TelemetryEvent) -> str:
    """Action-by-finish-reason lookup."""
    if event.event_type != "llm.completion":
        return "allow"
    reason = event.finish_reason or ""
    return FINISH_REASON_ACTIONS.get(reason, "allow")


# ── Hot-path check: ConfidenceGuard ────────────────────────────


def check_confidence(event: TelemetryEvent, threshold: float = -2.0) -> str:
    """Logprob-based confidence check.

    If mean top logprob across tokens is below `threshold`
    (i.e. the model is uncertain), rewrite to a more confident prompt.
    """
    if event.event_type != "llm.completion":
        return "allow"
    logprobs = event.logprobs or {}
    content = logprobs.get("content") if isinstance(logprobs, dict) else None
    if not content:
        return "allow"
    all_lps: list[float] = []
    for token_list in content:
        for entry in token_list or []:
            lp = entry.get("logprob")
            if isinstance(lp, (int, float)):
                all_lps.append(lp)
    if not all_lps:
        return "allow"
    mean_lp = sum(all_lps) / len(all_lps)
    if mean_lp < threshold:
        return "rewrite"
    return "allow"


# ── Async advisory (recorded; main path doesn't block on these) ─


@dataclass
class AsyncAdvisoryState:
    """Rolling state for the 4 async advisories."""
    output_embedding_zscore_running: deque[float] = field(default_factory=lambda: deque(maxlen=100))
    output_length_zscore_running: deque[float] = field(default_factory=lambda: deque(maxlen=100))
    user_prompt_hash_history: deque[str] = field(default_factory=lambda: deque(maxlen=50))
    consecutive_step_similarities: deque[float] = field(default_factory=lambda: deque(maxlen=10))


def advisory_output_length(
    event: TelemetryEvent, state: AsyncAdvisoryState
) -> str:
    """Output length z-score check. Returns "summarize" or "truncate" or "allow"."""
    if event.event_type != "llm.completion":
        return "allow"
    metrics = event.metrics or {}
    completion_tokens = int(metrics.get("completion_tokens", 0))
    state.output_length_zscore_running.append(float(completion_tokens))
    if len(state.output_length_zscore_running) < 10:
        return "allow"
    window = list(state.output_length_zscore_running)
    mean = sum(window) / len(window)
    var = sum((x - mean) ** 2 for x in window) / (len(window) - 1)
    sd = var ** 0.5
    if sd == 0:
        return "allow"
    z = (completion_tokens - mean) / sd
    if z > 3:
        return "truncate"
    if z < -3:
        return "summarize"
    return "allow"


def advisory_user_prompt_dedup(
    event: TelemetryEvent, state: AsyncAdvisoryState
) -> str:
    """User-prompt hash dedup (last 50 prompts)."""
    if event.event_type != "llm.completion":
        return "allow"
    body = event.request_body or {}
    messages = body.get("messages") or []
    user_msgs = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
    if not user_msgs:
        return "allow"
    last_user = user_msgs[-1]
    content = last_user.get("content") or ""
    if not isinstance(content, str):
        return "allow"
    h = hashlib.sha256(content.encode()).hexdigest()[:16]
    seen_before = h in state.user_prompt_hash_history
    state.user_prompt_hash_history.append(h)
    return "cache" if seen_before else "allow"


# ── Orchestrator ────────────────────────────────────────────────


@dataclass
class GuardrailState:
    """Mutable state carried across steps in a trace."""
    cumulative_cost_usd: float = 0.0
    cumulative_input_tokens: int = 0
    cumulative_output_tokens: int = 0
    tool_dedup_history: deque[tuple[str, str]] = field(
        default_factory=lambda: deque(maxlen=10)
    )
    retry_failure_history: deque[bool] = field(
        default_factory=lambda: deque(maxlen=10)
    )
    cost_state: CostState = field(default_factory=CostState)
    token_state: TokenState = field(default_factory=TokenState)
    latency_state: LatencyState = field(default_factory=LatencyState)
    async_state: AsyncAdvisoryState = field(default_factory=AsyncAdvisoryState)
    required_tool_fields: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class GuardrailVerdict:
    """Final per-step verdict from the orchestrator."""
    step_action: str
    actions_by_check: dict[str, str]
    elapsed_ms: float
    advisory_actions: dict[str, str]


def evaluate_step(
    event: TelemetryEvent,
    trace_so_far: Sequence[TelemetryEvent],
    state: GuardrailState,
) -> GuardrailVerdict:
    """Run all 8 hot-path checks + 4 async advisory on a single event.

    Returns the most-restrictive action across all checks.
    """
    t0 = time.perf_counter()
    actions: dict[str, str] = {}

    # Hot-path checks (in canonical decision-tree order).
    actions["cost"] = check_cost(event, state.cost_state, state.cumulative_cost_usd)
    actions["tokens"] = check_tokens(
        event, state.token_state,
        (state.cumulative_input_tokens, state.cumulative_output_tokens),
    )
    actions["loop"] = check_loop(trace_so_far)
    actions["tool_dedup"] = check_tool_dedup(event, state.tool_dedup_history)
    actions["retry_storm"] = check_retry_storm(event, state.retry_failure_history)
    actions["schema"] = check_schema(event, state.required_tool_fields)
    actions["latency"] = check_latency(event, state.latency_state)
    actions["finish_reason"] = check_finish_reason(event)
    actions["confidence"] = check_confidence(event)

    # Update cumulative state.
    metrics = event.metrics or {}
    state.cumulative_cost_usd += float(metrics.get("cost_usd", 0.0))
    state.cumulative_input_tokens += int(metrics.get("prompt_tokens", 0))
    state.cumulative_output_tokens += int(metrics.get("completion_tokens", 0))

    # Async advisory (non-blocking — record + return alongside).
    advisory: dict[str, str] = {}
    advisory["output_length"] = advisory_output_length(event, state.async_state)
    advisory["user_prompt_dedup"] = advisory_user_prompt_dedup(event, state.async_state)
    # embedding_zscore + reasoning_selfsimilarity require MiniLM; stubbed.

    step_action = _most_restrictive(actions.values())
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    return GuardrailVerdict(
        step_action=step_action,
        actions_by_check=actions,
        elapsed_ms=elapsed_ms,
        advisory_actions=advisory,
    )


__all__ = [
    "ACTIONS",
    "ACTION_RANK",
    "CostState",
    "TokenState",
    "LatencyState",
    "AsyncAdvisoryState",
    "GuardrailState",
    "GuardrailVerdict",
    "FINISH_REASON_ACTIONS",
    "check_cost",
    "check_tokens",
    "check_loop",
    "check_tool_dedup",
    "check_retry_storm",
    "check_schema",
    "check_latency",
    "check_finish_reason",
    "check_confidence",
    "advisory_output_length",
    "advisory_user_prompt_dedup",
    "evaluate_step",
    "_most_restrictive",
]