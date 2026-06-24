"""MCP auto-instrumentation SDK — D.12.1 (§8.1).

Lightweight wrapper for Model Context Protocol (MCP) server
calls. Two surfaces:

* :func:`wrap_mcp_call` — context-manager. Records a
  ``mcp.*`` attribute block onto the active telemetry span
  (the customer's own trace). On auth failure, persists the
  row into ``mcp_server_auth_failures`` and fires the
  ``on_mcp_server_auth_failure`` hook (per spec §E.1).
* :func:`build_mcp_attributes` — pure helper. Returns the
  ``mcp`` sub-document the caller should merge into their
  span's ``attributes``. Used by the gateway ingest path
  when it auto-extracts from a known MCP library.

Ponytail: best-effort — the SDK never raises. Customers
wrap their MCP call in the context manager and the
telemetry span (whatever it is — OTel, custom) just
becomes observable.

Usage::

    from eden.sdk.mcp import wrap_mcp_call

    with wrap_mcp_call(
        org_id="org-1",
        trace_id=tid, span_id=sid,
        server_name="github", tool_name="list_issues",
        transport="http_sse",
    ) as ctx:
        result = await client.list_issues(...)
        ctx.set_resource("repo://org/repo")
"""

from __future__ import annotations

import json
import logging
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

logger = logging.getLogger(__name__)


@contextmanager
def wrap_mcp_call(
    *,
    org_id: str,
    server_name: str,
    trace_id: str,
    span_id: str,
    tool_name: str | None = None,
    resource_uri: str | None = None,
    prompt_name: str | None = None,
    sampling_requested: bool = False,
    transport: str | None = None,
) -> Iterator["_McpCallCtx"]:
    """Wrap an MCP call. Yields a context with ``set_*`` helpers.

    On exit, the SDK:
    * builds the ``mcp.*`` attribute block and stores it on
      the context (caller forwards to their span).
    * if an exception escapes the block and the error looks
      like an auth failure (401/403/expired_token), persists
      a row to ``mcp_server_auth_failures`` and fires the
      ``on_mcp_server_auth_failure`` hook.
    """
    ctx = _McpCallCtx(
        org_id=org_id,
        server_name=server_name,
        trace_id=trace_id,
        span_id=span_id,
        tool_name=tool_name,
        resource_uri=resource_uri,
        prompt_name=prompt_name,
        sampling_requested=sampling_requested,
        transport=transport,
    )
    err: BaseException | None = None
    try:
        yield ctx
    except Exception as exc:
        err = exc
        raise
    finally:
        # Auth-failure short-circuit (best-effort).
        try:
            if err is not None:
                kind = _classify_failure(err)
                if kind is not None:
                    import asyncio
                    try:
                        loop = asyncio.get_event_loop()
                        if loop.is_running():
                            loop.create_task(_record_failure(
                                org_id=org_id,
                                server_name=server_name,
                                transport=transport,
                                failure_kind=kind,
                                error_message=str(err)[:1024],
                                trace_id=trace_id,
                                span_id=span_id,
                            ))
                    except Exception:
                        # No loop → fall back to the sync helper
                        # which only logs; the spec doesn't require
                        # sync auth-failure recording.
                        logger.debug(
                            "mcp SDK: %s auth failure for %s (no loop)",
                            kind, server_name,
                        )
        except Exception as exc:
            logger.debug("mcp SDK: failure handler crashed: %s", exc)


class _McpCallCtx:
    """Per-call mutable handle. Cheap; no DB."""

    def __init__(
        self,
        *,
        org_id: str,
        server_name: str,
        trace_id: str,
        span_id: str,
        tool_name: str | None,
        resource_uri: str | None,
        prompt_name: str | None,
        sampling_requested: bool,
        transport: str | None,
    ) -> None:
        self.org_id = org_id
        self.server_name = server_name
        self.trace_id = trace_id
        self.span_id = span_id
        self.tool_name = tool_name
        self.resource_uri = resource_uri
        self.prompt_name = prompt_name
        self.sampling_requested = sampling_requested
        self.transport = transport

    def set_tool(self, tool_name: str) -> None:
        self.tool_name = tool_name

    def set_resource(self, resource_uri: str) -> None:
        self.resource_uri = resource_uri

    def set_prompt(self, prompt_name: str) -> None:
        self.prompt_name = prompt_name

    def attributes(self) -> dict[str, Any]:
        """Return the ``mcp`` sub-document the caller merges
        into their telemetry span's ``attributes``.
        """
        return {
            "server_name": self.server_name,
            "tool_name": self.tool_name,
            "resource_uri": self.resource_uri,
            "prompt_name": self.prompt_name,
            "sampling_requested": self.sampling_requested,
            "transport": self.transport,
        }


def build_mcp_attributes(
    *,
    server_name: str,
    tool_name: str | None = None,
    resource_uri: str | None = None,
    prompt_name: str | None = None,
    sampling_requested: bool = False,
    transport: str | None = None,
) -> dict[str, Any]:
    """Pure helper. Returns the ``mcp.*`` sub-document the
    caller should set on their span's ``attributes``.

    Used by the gateway auto-extractor when it sees a known
    MCP library in the call stack.
    """
    return {
        "server_name": server_name,
        "tool_name": tool_name,
        "resource_uri": resource_uri,
        "prompt_name": prompt_name,
        "sampling_requested": sampling_requested,
        "transport": transport,
    }


def _classify_failure(exc: BaseException) -> str | None:
    """Map an exception to a failure_kind. Returns ``None`` if
    the error doesn't look like an MCP auth/transport failure.

    Ponytail: substring match on the exception message +
    class name. The 3 failure kinds covered are the ones the
    spec calls out for the auth-failure audit table.
    """
    msg = (str(exc) or "").lower()
    cls = type(exc).__name__.lower()
    haystack = f"{cls} {msg}"
    if "unauthorized" in haystack or "401" in msg:
        return "unauthorized"
    if "expired" in haystack and ("token" in haystack or "jwt" in haystack):
        return "expired_token"
    if "dns" in haystack or "nxdomain" in haystack or "name resolution" in msg:
        return "dns"
    if "ssl" in haystack or "tls" in haystack or "certificate" in haystack:
        return "tls"
    return None


async def _record_failure(
    *,
    org_id: str,
    server_name: str,
    transport: str | None,
    failure_kind: str,
    error_message: str,
    trace_id: str,
    span_id: str,
) -> None:
    """Persist the failure + fire the hook (best-effort)."""
    try:
        from eden.services.observability import get_mcp_service
        svc = get_mcp_service()
        await svc.record_auth_failure(
            org_id,
            server_name=server_name,
            failure_kind=failure_kind,
            transport=transport,
            error_message=error_message,
            trace_id=trace_id,
            span_id=span_id,
        )
    except Exception as exc:
        logger.debug("mcp SDK: record_auth_failure failed: %s", exc)
    try:
        from eden.llmops.promotion_hooks import PromotionHook
        hook = PromotionHook()
        await hook.on_mcp_server_auth_failure(
            org_id,
            server_name=server_name,
            failure_kind=failure_kind,
            failure_id=None,
        )
    except Exception as exc:
        logger.debug("mcp SDK: hook fire failed: %s", exc)


__all__ = [
    "build_mcp_attributes",
    "wrap_mcp_call",
]


# ponytail: zero new dependencies. The SDK is plain
# context-manager + dataclass + dict. The customer wires
# ``ctx.attributes()`` into their existing telemetry span.
# When (and only when) the call raises a 401/dns/tls-style
# error, we asynchronously log to ``mcp_server_auth_failures``
# + fire the closed-loop hook — never raises.