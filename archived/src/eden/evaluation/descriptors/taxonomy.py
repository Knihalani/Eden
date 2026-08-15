"""Operator-facing descriptor IDs for Layer A (agent trajectory failures).

Ambitious structural + high-precision semantic heuristic set aiming at
SLM-comparable coverage on agent traces without a neural net.
"""

from __future__ import annotations

from enum import StrEnum


class DescriptorId(StrEnum):
    # ── Tool-use ──────────────────────────────────────────────────
    BAD_TOOL_ARGS = "bad_tool_args"
    TOOL_ERROR = "tool_error"
    EMPTY_TOOL_RESULT = "empty_tool_result"
    ERROR_SWALLOW = "error_swallow"
    REPETITIVE_TOOL_CALL = "repetitive_tool_call"
    UNNECESSARY_TOOL_CALL = "unnecessary_tool_call"
    TOOL_SKIP = "tool_skip"
    WRONG_TOOL = "wrong_tool"
    EXTRA_TOOL_CALL = "extra_tool_call"
    RESULT_IGNORE = "result_ignore"
    PARTIAL_RESULT_USE = "partial_result_use"
    OUTPUT_FABRICATION = "output_fabrication"
    STALE_TOOL_RESULT = "stale_tool_result"

    # ── Trajectory / planning / long-running agents ───────────────
    LOOPING = "looping"
    CONFUSION_LOOP = "confusion_loop"
    RETRY_STORM = "retry_storm"
    SLIDING_WINDOW_LOOP = "sliding_window_loop"
    TOOL_THRASH = "tool_thrash"
    ASSISTANT_ECHO_LOOP = "assistant_echo_loop"
    EXCESSIVE_STEPS = "excessive_steps"
    EXCESSIVE_CLARIFICATION = "excessive_clarification"
    ACTION_INCOMPLETE = "action_incomplete"
    GOAL_ABANDONED = "goal_abandoned"
    PLAN_DRIFT = "plan_drift"
    NO_PROGRESS = "no_progress"
    TIMEOUT = "timeout"
    DEAD_END = "dead_end"

    # ── Content / user / safety ───────────────────────────────────
    INACCURACY = "inaccuracy"
    USER_FRUSTRATION = "user_frustration"
    CONTRADICTION = "contradiction"
    REFUSAL_INAPPROPRIATE = "refusal_inappropriate"
    MCP_AUTH_FAILURE = "mcp_auth_failure"
    JAILBREAK_ATTEMPT = "jailbreak_attempt"
    PII_LEAK_RISK = "pii_leak_risk"
    COST_SPIKE = "cost_spike"


DESCRIPTOR_IDS: frozenset[str] = frozenset(d.value for d in DescriptorId)

# Highest-precision structural set (rules ≈ SLM or better).
LAYER_A_PRIMARY: frozenset[str] = frozenset(
    {
        DescriptorId.BAD_TOOL_ARGS.value,
        DescriptorId.TOOL_ERROR.value,
        DescriptorId.EMPTY_TOOL_RESULT.value,
        DescriptorId.ERROR_SWALLOW.value,
        DescriptorId.TIMEOUT.value,
        DescriptorId.LOOPING.value,
        DescriptorId.REPETITIVE_TOOL_CALL.value,
        DescriptorId.RETRY_STORM.value,
        DescriptorId.SLIDING_WINDOW_LOOP.value,
        DescriptorId.TOOL_THRASH.value,
        DescriptorId.ASSISTANT_ECHO_LOOP.value,
        DescriptorId.CONFUSION_LOOP.value,
        DescriptorId.EXCESSIVE_STEPS.value,
        DescriptorId.EXCESSIVE_CLARIFICATION.value,
        DescriptorId.MCP_AUTH_FAILURE.value,
        DescriptorId.COST_SPIKE.value,
        DescriptorId.USER_FRUSTRATION.value,
        DescriptorId.NO_PROGRESS.value,
    }
)

# High-precision heuristics that approach SLM on constrained inputs.
LAYER_A_HEURISTIC: frozenset[str] = frozenset(
    {
        DescriptorId.RESULT_IGNORE.value,
        DescriptorId.PARTIAL_RESULT_USE.value,
        DescriptorId.UNNECESSARY_TOOL_CALL.value,
        DescriptorId.TOOL_SKIP.value,
        DescriptorId.WRONG_TOOL.value,
        DescriptorId.EXTRA_TOOL_CALL.value,
        DescriptorId.OUTPUT_FABRICATION.value,
        DescriptorId.INACCURACY.value,
        DescriptorId.ACTION_INCOMPLETE.value,
        DescriptorId.GOAL_ABANDONED.value,
        DescriptorId.PLAN_DRIFT.value,
        DescriptorId.DEAD_END.value,
        DescriptorId.STALE_TOOL_RESULT.value,
        DescriptorId.CONTRADICTION.value,
        DescriptorId.REFUSAL_INAPPROPRIATE.value,
        DescriptorId.JAILBREAK_ATTEMPT.value,
        DescriptorId.PII_LEAK_RISK.value,
    }
)

# Online hot-path: cheap, high-value detectors first (long-agent damage).
ONLINE_CRITICAL: frozenset[str] = frozenset(
    {
        DescriptorId.LOOPING.value,
        DescriptorId.REPETITIVE_TOOL_CALL.value,
        DescriptorId.RETRY_STORM.value,
        DescriptorId.SLIDING_WINDOW_LOOP.value,
        DescriptorId.TOOL_THRASH.value,
        DescriptorId.ASSISTANT_ECHO_LOOP.value,
        DescriptorId.NO_PROGRESS.value,
        DescriptorId.EXCESSIVE_STEPS.value,
        DescriptorId.TOOL_ERROR.value,
        DescriptorId.MCP_AUTH_FAILURE.value,
        DescriptorId.BAD_TOOL_ARGS.value,
        DescriptorId.TIMEOUT.value,
        DescriptorId.COST_SPIKE.value,
        DescriptorId.ERROR_SWALLOW.value,
        DescriptorId.DEAD_END.value,
        DescriptorId.USER_FRUSTRATION.value,
    }
)

DISPLAY_NAMES: dict[str, str] = {
    DescriptorId.BAD_TOOL_ARGS.value: "Bad tool arguments",
    DescriptorId.TOOL_ERROR.value: "Tool error",
    DescriptorId.EMPTY_TOOL_RESULT.value: "Empty tool result",
    DescriptorId.ERROR_SWALLOW.value: "Swallowed tool error",
    DescriptorId.REPETITIVE_TOOL_CALL.value: "Repetitive tool call",
    DescriptorId.UNNECESSARY_TOOL_CALL.value: "Unnecessary tool call",
    DescriptorId.TOOL_SKIP.value: "Skipped required tool",
    DescriptorId.WRONG_TOOL.value: "Wrong tool",
    DescriptorId.EXTRA_TOOL_CALL.value: "Extra tool call",
    DescriptorId.RESULT_IGNORE.value: "Ignored tool result",
    DescriptorId.PARTIAL_RESULT_USE.value: "Partial result use",
    DescriptorId.OUTPUT_FABRICATION.value: "Output fabrication",
    DescriptorId.STALE_TOOL_RESULT.value: "Stale tool result",
    DescriptorId.LOOPING.value: "Looping",
    DescriptorId.CONFUSION_LOOP.value: "Confusion loop",
    DescriptorId.RETRY_STORM.value: "Retry storm",
    DescriptorId.SLIDING_WINDOW_LOOP.value: "Sliding-window loop",
    DescriptorId.TOOL_THRASH.value: "Tool thrash",
    DescriptorId.ASSISTANT_ECHO_LOOP.value: "Assistant echo loop",
    DescriptorId.EXCESSIVE_STEPS.value: "Excessive steps",
    DescriptorId.EXCESSIVE_CLARIFICATION.value: "Excessive clarification",
    DescriptorId.ACTION_INCOMPLETE.value: "Action incomplete",
    DescriptorId.GOAL_ABANDONED.value: "Goal abandoned",
    DescriptorId.PLAN_DRIFT.value: "Plan drift",
    DescriptorId.NO_PROGRESS.value: "No progress",
    DescriptorId.TIMEOUT.value: "Timeout",
    DescriptorId.DEAD_END.value: "Dead end",
    DescriptorId.INACCURACY.value: "Inaccuracy",
    DescriptorId.USER_FRUSTRATION.value: "User frustration",
    DescriptorId.CONTRADICTION.value: "Contradiction",
    DescriptorId.REFUSAL_INAPPROPRIATE.value: "Inappropriate refusal",
    DescriptorId.MCP_AUTH_FAILURE.value: "MCP auth failure",
    DescriptorId.JAILBREAK_ATTEMPT.value: "Jailbreak attempt",
    DescriptorId.PII_LEAK_RISK.value: "PII leak risk",
    DescriptorId.COST_SPIKE.value: "Cost spike",
}

# Mutual exclusion: if A fires, suppress B (keep higher-priority winner).
SUPPRESS_WHEN: dict[str, frozenset[str]] = {
    DescriptorId.MCP_AUTH_FAILURE.value: frozenset({DescriptorId.TOOL_ERROR.value}),
    DescriptorId.INACCURACY.value: frozenset({DescriptorId.OUTPUT_FABRICATION.value}),
    DescriptorId.OUTPUT_FABRICATION.value: frozenset(
        {DescriptorId.RESULT_IGNORE.value, DescriptorId.PARTIAL_RESULT_USE.value}
    ),
    DescriptorId.RESULT_IGNORE.value: frozenset({DescriptorId.PARTIAL_RESULT_USE.value}),
    DescriptorId.DEAD_END.value: frozenset({DescriptorId.ACTION_INCOMPLETE.value}),
    # Specific long-agent labels beat generic looping / no_progress
    DescriptorId.RETRY_STORM.value: frozenset(
        {DescriptorId.NO_PROGRESS.value, DescriptorId.LOOPING.value}
    ),
    DescriptorId.SLIDING_WINDOW_LOOP.value: frozenset({DescriptorId.LOOPING.value}),
    DescriptorId.TOOL_THRASH.value: frozenset({DescriptorId.NO_PROGRESS.value}),
    DescriptorId.ASSISTANT_ECHO_LOOP.value: frozenset({DescriptorId.CONFUSION_LOOP.value}),
}

# Intent keyword → preferred tool name fragments (wrong_tool / tool_skip).
INTENT_TOOL_AFFINITY: dict[str, tuple[str, ...]] = {
    "weather": ("weather", "forecast", "temperature", "climate"),
    "transfer": ("transfer", "payment", "pay", "send_money", "bank", "wire"),
    "email": ("email", "mail", "send_email", "smtp", "inbox"),
    "search": ("search", "lookup", "find", "query", "kb", "rag", "retrieve"),
    "order": ("order", "shipment", "shipping", "tracking", "track", "fulfillment", "package"),
    "cancel": ("cancel", "void", "refund"),
    "calendar": ("calendar", "schedule", "meeting", "event", "appoint"),
    "code": ("code", "github", "repo", "pull_request", "commit", "git"),
    "database": ("sql", "db", "query", "postgres", "database"),
    "file": ("file", "read_file", "write_file", "fs", "s3", "document"),
    "message": ("slack", "sms", "notify", "message", "chat"),
    "user": ("user", "profile", "account", "customer", "crm"),
}
