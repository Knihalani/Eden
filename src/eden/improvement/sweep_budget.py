"""Per-sweep LLM call budget shared by ImprovementAgent + PatchGenerator."""

from __future__ import annotations

from contextvars import ContextVar

_llm_calls_remaining: ContextVar[int | None] = ContextVar(
    "improvement_sweep_llm_calls_remaining", default=None
)


def begin_sweep_llm_budget(max_calls: int) -> None:
    _llm_calls_remaining.set(max(0, int(max_calls)))


def clear_sweep_llm_budget() -> None:
    _llm_calls_remaining.set(None)


def try_consume_llm_call() -> bool:
    """Consume one sweep LLM call slot. True when allowed (or no budget set)."""
    left = _llm_calls_remaining.get()
    if left is None:
        return True
    if left <= 0:
        return False
    _llm_calls_remaining.set(left - 1)
    return True


def llm_calls_remaining() -> int | None:
    return _llm_calls_remaining.get()
