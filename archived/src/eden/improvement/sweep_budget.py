"""Per-sweep LLM call budget shared by ImprovementAgent + PatchGenerator.

COST: this budget used to be a no-op on every entry path except
``ImprovementAgent._sweep_body``. ``try_consume_llm_call`` returned True
whenever no budget had been armed, and the closed-loop
(``propose_patch`` action) and promotion-hook paths never armed one — so
patch generation could fan out gen+critic LLM pairs without any ceiling.

Two changes close that hole:

* :func:`llm_budget_scope` arms a default budget for a block of work and
  restores the previous one on exit. Callers that already armed a budget
  (the sweep) are left alone, so a sweep-wide ceiling is never widened by
  an inner scope.
* :func:`try_consume_llm_call` now fails **closed** inside a context that
  declared a budget mandatory, instead of waving the call through.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from contextvars import ContextVar

_llm_calls_remaining: ContextVar[int | None] = ContextVar(
    "improvement_sweep_llm_calls_remaining", default=None
)
# Marks a context in which spending LLM calls REQUIRES an armed budget.
# Without this, "no budget armed" is indistinguishable from "unlimited".
_llm_budget_required: ContextVar[bool] = ContextVar(
    "improvement_sweep_llm_budget_required", default=False
)


def begin_sweep_llm_budget(max_calls: int) -> None:
    """Arm a budget for the current context (ImprovementAgent sweep)."""
    _llm_calls_remaining.set(max(0, int(max_calls)))
    _llm_budget_required.set(True)


def clear_sweep_llm_budget() -> None:
    _llm_calls_remaining.set(None)
    _llm_budget_required.set(False)


@contextlib.contextmanager
def llm_budget_scope(max_calls: int) -> Iterator[None]:
    """Arm ``max_calls`` for this block unless a budget is already armed.

    Used by entry paths that are not sweeps (closed-loop actions,
    promotion hooks) so they cannot spend without a ceiling. When an
    outer budget exists it is deliberately left untouched — an inner
    scope must never widen the sweep's remaining allowance.
    """
    if _llm_calls_remaining.get() is not None:
        yield
        return
    calls_token = _llm_calls_remaining.set(max(0, int(max_calls)))
    required_token = _llm_budget_required.set(True)
    try:
        yield
    finally:
        _llm_calls_remaining.reset(calls_token)
        _llm_budget_required.reset(required_token)


def try_consume_llm_call() -> bool:
    """Consume one LLM call slot.

    Returns False when the budget is exhausted, and — inside a context
    that requires a budget — also when no budget was ever armed.
    """
    left = _llm_calls_remaining.get()
    if left is None:
        # Fail CLOSED where a budget is mandatory; stay permissive for
        # callers that legitimately run outside any budgeted scope.
        return not _llm_budget_required.get()
    if left <= 0:
        return False
    _llm_calls_remaining.set(left - 1)
    return True


def llm_calls_remaining() -> int | None:
    return _llm_calls_remaining.get()


def llm_budget_required() -> bool:
    """Whether the current context mandates an armed LLM budget."""
    return _llm_budget_required.get()
