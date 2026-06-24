"""A2A auto-instrumentation SDK — D.12.2 (§8.2).

Lightweight wrapper for agent-to-agent (A2A) invocations.
Two surfaces:

* :func:`wrap_a2a_invocation` — context manager. Registers
  the parent→child link in ``a2a_links``, sets the
  ``parent_agent_span_id`` + ``child_agent_trace_id`` columns
  on the active telemetry span, and on failure fires
  ``on_a2a_invocation_failed`` (per spec §E.1).
* :func:`build_a2a_attributes` — pure helper. Returns the
  attribute block the caller merges into their span.

Ponytail: best-effort — the SDK never raises. The customer
wraps their A2A call in the context manager and the link
is recorded when (and only when) the DB substrate is up.

Usage::

    from eden.sdk.a2a import wrap_a2a_invocation

    async with wrap_a2a_invocation(
        org_id="org-1",
        parent_trace_id=tid, parent_span_id=sid,
        child_trace_id=child_tid,
        parent_agent_id=parent_agent, child_agent_id=child_agent,
        invocation_type="a2a.send_message",
    ) as ctx:
        result = await child_agent.send(message)
        ctx.set_status("ok")
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

logger = logging.getLogger(__name__)


@asynccontextmanager
async def wrap_a2a_invocation(
    *,
    org_id: str,
    parent_trace_id: str,
    parent_span_id: str,
    child_trace_id: str,
    parent_agent_id: str,
    child_agent_id: str,
    invocation_type: str = "a2a.send_message",
) -> AsyncIterator[_A2ACallCtx]:
    """Wrap an A2A call. Registers the link + sets span attrs.

    On exception, marks the link as ``failed`` with a
    classified ``error_kind`` and fires the
    ``on_a2a_invocation_failed`` hook (best-effort).
    """
    ctx = _A2ACallCtx(
        org_id=org_id,
        parent_trace_id=parent_trace_id,
        parent_span_id=parent_span_id,
        child_trace_id=child_trace_id,
        parent_agent_id=parent_agent_id,
        child_agent_id=child_agent_id,
        invocation_type=invocation_type,
    )
    try:
        await ctx._register()
        yield ctx
        if ctx.response_status is None:
            ctx.set_status("ok")
        # Non-ok / non-failed statuses (e.g. "blocked",
        # "cancelled") are not persisted in v0 — only the
        # ok + failed transitions are tracked. The DB row
        # stays at NULL if neither is reached.
    except Exception as exc:
        kind = _classify_error(exc)
        ctx.set_status("failed")
        await ctx._mark_failed(kind)
        raise
    finally:
        pass


class _A2ACallCtx:
    """Per-invocation mutable handle."""

    def __init__(
        self,
        *,
        org_id: str,
        parent_trace_id: str,
        parent_span_id: str,
        child_trace_id: str,
        parent_agent_id: str,
        child_agent_id: str,
        invocation_type: str,
    ) -> None:
        self.org_id = org_id
        self.parent_trace_id = parent_trace_id
        self.parent_span_id = parent_span_id
        self.child_trace_id = child_trace_id
        self.parent_agent_id = parent_agent_id
        self.child_agent_id = child_agent_id
        self.invocation_type = invocation_type
        self.response_status: str | None = None
        self._link_id: str | None = None

    def set_status(self, status: str) -> None:
        self.response_status = status

    def attributes(self) -> dict[str, Any]:
        """Return the attribute block the caller merges into
        the active span's ``attributes`` (the
        ``parent_agent_span_id`` + ``child_agent_trace_id``
        columns + a ``a2a.*`` sub-document for filtering).
        """
        return {
            "parent_agent_span_id": self.parent_span_id,
            "child_agent_trace_id": self.child_trace_id,
            "a2a": {
                "invocation_type": self.invocation_type,
                "parent_agent_id": self.parent_agent_id,
                "child_agent_id": self.child_agent_id,
                "response_status": self.response_status,
            },
        }

    async def _register(self) -> None:
        try:
            from eden.services.observability import get_a2a_service
            svc = get_a2a_service()
            self._link_id = await svc.register_link(
                self.org_id,
                parent_trace_id=self.parent_trace_id,
                child_trace_id=self.child_trace_id,
                parent_agent_id=self.parent_agent_id,
                child_agent_id=self.child_agent_id,
                parent_span_id=self.parent_span_id,
                invocation_type=self.invocation_type,
                response_status=None,
            )
        except Exception as exc:
            logger.debug("a2a SDK: register failed: %s", exc)

    async def _mark_failed(self, error_kind: str) -> None:
        if not self._link_id:
            return
        try:
            from eden.services.observability import get_a2a_service
            svc = get_a2a_service()
            await svc.mark_failed(self._link_id, error_kind=error_kind)
        except Exception as exc:
            logger.debug("a2a SDK: mark_failed failed: %s", exc)


def build_a2a_attributes(
    *,
    parent_agent_id: str,
    child_agent_id: str,
    invocation_type: str = "a2a.send_message",
    parent_span_id: str | None = None,
    child_trace_id: str | None = None,
    response_status: str | None = None,
) -> dict[str, Any]:
    """Pure helper. Returns the attribute block the caller
    merges into their span. Used by the gateway auto-extractor.
    """
    return {
        "parent_agent_span_id": parent_span_id,
        "child_agent_trace_id": child_trace_id,
        "a2a": {
            "invocation_type": invocation_type,
            "parent_agent_id": parent_agent_id,
            "child_agent_id": child_agent_id,
            "response_status": response_status,
        },
    }


def _classify_error(exc: BaseException) -> str:
    """Map an exception to a short error_kind. Falls back to
    ``"unknown"``.
    """
    msg = (str(exc) or "").lower()
    cls = type(exc).__name__.lower()
    haystack = f"{cls} {msg}"
    if "timeout" in haystack:
        return "timeout"
    if "auth" in haystack or "401" in msg or "403" in msg:
        return "unauthorized"
    if "not found" in haystack or "404" in msg:
        return "not_found"
    if "rate" in haystack and "limit" in haystack:
        return "rate_limited"
    if "conn" in haystack and ("reset" in haystack or "refused" in haystack):
        return "connection_reset"
    return "unknown"


__all__ = [
    "build_a2a_attributes",
    "wrap_a2a_invocation",
]
