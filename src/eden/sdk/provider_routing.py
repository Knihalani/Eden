"""Provider routing SDK — D.12.6 (§2.12).

Lightweight wrapper for the 4-decision provider-routing
state machine (per spec §B.8). Two top-level surfaces:

* :func:`record_attempt` — async helper. Persists a single
  routing attempt to ``provider_routing_attempts`` via
  :class:`ProviderRoutingService.record_attempt`. Best-effort.
* :func:`retry_with_fallback` — async convenience. Tries
  the primary provider; on failure, walks the
  ``fallback_providers`` list (each as a single attempt)
  and records the full routing trace. Returns the first
  successful result (or raises the last error if all
  fallbacks fail).

Plus the pure helpers:

* :func:`build_provider_routing_attributes` — returns the
  ``provider_routing.*`` sub-document the caller merges
  into their span's ``attributes``. Used by the gateway
  auto-extractor when it sees a known routing library
  (LiteLLM / Portkey / OpenRouter) in the call stack.

Ponytail: best-effort — the SDK never raises. The customer
wraps their LLM call in :func:`retry_with_fallback` and the
full routing trace (primary + every fallback) is recorded
when (and only when) the DB substrate is up. The customer
keeps their own circuit-breaker state in-process; the
Eden service exposes the per-(org, provider) failure rate
for the operator's dashboard + the
``on_provider_routing_repeated_failures`` hook.

Usage::

    from eden.sdk.provider_routing import retry_with_fallback

    result = await retry_with_fallback(
        org_id="org-1",
        trace_id=tid, span_id=sid,
        primary=("openai", "gpt-4o-mini"),
        fallback_providers=[
            ("anthropic", "claude-3-5-sonnet-latest"),
            ("google", "gemini-1.5-pro"),
        ],
        # The actual call is supplied by the caller — the SDK
        # just records the decision.
        caller=lambda provider, model: openai_client.complete(
            model=model, ...
        ),
    )
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)


# 4 spec'd decisions per §B.8. Mirrors
# services.observability.DECISIONS.
_DECISIONS: tuple[str, ...] = (
    "success", "fallback", "retry", "abort",
)


async def record_attempt(
    org_id: str,
    *,
    trace_id: str,
    span_id: str,
    attempted_provider: str,
    attempted_model: str,
    sequence_index: int,
    decision: str,
    failure_reason: str | None = None,
    latency_ms: int | None = None,
) -> str | None:
    """Persist a provider-routing attempt. Best-effort.

    Idempotent on ``(trace_id, sequence_index)`` (R-13).
    Returns the attempt id (or ``None`` on substrate error
    / unknown decision).
    """
    if decision not in _DECISIONS:
        logger.debug("provider_routing SDK: unknown decision %r", decision)
        return None
    try:
        from eden.services.observability import get_provider_routing_service
        svc = get_provider_routing_service()
        return await svc.record_attempt(
            org_id,
            trace_id=trace_id,
            span_id=span_id,
            attempted_provider=attempted_provider,
            attempted_model=attempted_model,
            sequence_index=int(sequence_index),
            decision=decision,
            failure_reason=failure_reason,
            latency_ms=latency_ms,
        )
    except Exception as exc:
        logger.debug("provider_routing SDK: record_attempt failed: %s", exc)
        return None


async def retry_with_fallback(
    org_id: str,
    *,
    trace_id: str,
    span_id: str,
    primary: tuple[str, str],
    fallback_providers: list[tuple[str, str]] | None = None,
    caller: Callable[[str, str], Awaitable[Any]],
) -> Any:
    """Try ``primary`` first, then walk ``fallback_providers``
    on failure. Each attempt is recorded with the 4-decision
    state machine. Returns the first successful result.

    The ``caller(provider, model)`` is supplied by the
    customer and does the actual LLM call. The SDK never
    raises from the recording path — DB errors are
    swallowed. The actual call may still raise (the
    customer decides how to handle the all-fallbacks-
    failed case).
    """
    fallback_providers = list(fallback_providers or [])
    chain = [primary, *fallback_providers]
    last_exc: BaseException | None = None
    for idx, (provider, model) in enumerate(chain):
        is_primary = idx == 0
        is_last = idx == len(chain) - 1
        try:
            result = await caller(provider, model)
            await record_attempt(
                org_id,
                trace_id=trace_id,
                span_id=span_id,
                attempted_provider=provider,
                attempted_model=model,
                sequence_index=idx,
                decision="success",
            )
            return result
        except Exception as exc:
            last_exc = exc
            if is_primary:
                # The primary attempt failed — move to fallback
                # (per spec R-13, we record as 'fallback' when
                # the next attempt will happen, and 'retry' if
                # we intend to retry the same attempt; here we
                # use 'fallback' because the chain advances).
                decision = "abort" if is_last else "fallback"
            else:
                # Mid-chain failure: also a fallback. The
                # 'retry' decision is reserved for the
                # same-provider-retry case the caller wires
                # separately.
                decision = "abort" if is_last else "fallback"
            await record_attempt(
                org_id,
                trace_id=trace_id,
                span_id=span_id,
                attempted_provider=provider,
                attempted_model=model,
                sequence_index=idx,
                decision=decision,
                failure_reason=f"{type(exc).__name__}: {exc}"[:1024],
            )
            if is_last:
                # All fallbacks exhausted — let the caller's
                # exception propagate.
                raise
            # Otherwise continue to the next provider.


def build_provider_routing_attributes(
    *,
    attempted_provider: str,
    attempted_model: str,
    decision: str,
    sequence_index: int,
    failure_reason: str | None = None,
    latency_ms: int | None = None,
) -> dict[str, Any]:
    """Pure helper. Returns the ``provider_routing.*``
    sub-document the caller should set on their span's
    ``attributes``. Used by the gateway auto-extractor
    when it sees a known routing library in the call stack.
    """
    return {
        "provider_routing": {
            "attempted_provider": attempted_provider,
            "attempted_model": attempted_model,
            "decision": decision,
            "sequence_index": int(sequence_index),
            "failure_reason": failure_reason,
            "latency_ms": latency_ms,
        },
    }


__all__ = [
    "build_provider_routing_attributes",
    "record_attempt",
    "retry_with_fallback",
]
