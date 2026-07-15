"""Self-report stumbles from user code (F28 ``self_diagnostic``).

``eden.record_stumble(...)`` lets an agent flag a failure it noticed
about itself — a bad tool result, a retry storm, a low-confidence answer.
The stumble is posted to the Eden create path
(``POST /orgs/{org_id}/stumbles``) and flows through the same
dedup + promotion pipeline as detector-created stumbles.

Design
------
* Non-blocking by default: the POST runs on a short-lived daemon thread
  so user code never waits on the network. Pass ``blocking=True`` (used
  by tests and short-lived scripts) to POST inline and get the response.
* Best-effort: any transport error is logged at WARNING and swallowed —
  a self-report must never break the caller.
* ``trace_id`` auto-fills from the active :func:`eden.current_trace` when
  omitted, so ``record_stumble("bad answer")`` inside a traced function
  correlates automatically.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

import httpx

from eden_sdk.config import EdenConfig, get_config

logger = logging.getLogger("eden_sdk.stumbles")

_USER_AGENT = "eden-sdk/0.3.0 (python)"

_VALID_KINDS = {
    "tool_error",
    "loop",
    "hallucination",
    "task_failure",
    "user_frustration",
    "timeout",
    "self_diagnostic",
    "mcp_auth_failure",
    "statgate_p0",
    "custom",
}


def _resolve_trace_id(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    try:
        from eden_sdk.trace import current_trace

        ctx = current_trace()
        return ctx.trace_id if ctx is not None else None
    except Exception:  # pragma: no cover - defensive
        return None


def _build_payload(
    *,
    title: str,
    kind: str,
    trace_id: str,
    detail: dict[str, Any] | None,
    severity: str | None,
    agent_id: str | None,
    span_id: str | None,
    session_id: str | None,
    user_id: str | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "trace_id": trace_id,
        "kind": kind,
        "title": title,
        "detail": detail or {},
    }
    if severity:
        payload["severity"] = severity
    if agent_id:
        payload["agent_id"] = agent_id
    if span_id:
        payload["span_id"] = span_id
    if session_id:
        payload["session_id"] = session_id
    if user_id:
        payload["user_id"] = user_id
    return payload


def _stumbles_url(config: EdenConfig) -> str:
    base = config.base_url.rstrip("/")
    return f"{base}/orgs/{config.org_id}/stumbles"


def _post_stumble(config: EdenConfig, payload: dict[str, Any]) -> dict[str, Any] | None:
    url = _stumbles_url(config)
    headers = config.auth_headers()
    headers.setdefault("Content-Type", "application/json")
    headers.setdefault("User-Agent", _USER_AGENT)
    transport = getattr(config, "transport", None)
    try:
        with httpx.Client(
            timeout=httpx.Timeout(config.timeout_s), transport=transport
        ) as client:
            resp = client.post(url, json=payload, headers=headers)
        if 200 <= resp.status_code < 300:
            try:
                return resp.json()
            except Exception:  # pragma: no cover - non-JSON 2xx
                return {"status": "ok"}
        logger.warning(
            "eden record_stumble returned %s: %s",
            resp.status_code,
            resp.text[:200],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("eden record_stumble failed: %s", exc)
    return None


def record_stumble(
    title: str,
    *,
    kind: str = "self_diagnostic",
    trace_id: str | None = None,
    detail: dict[str, Any] | None = None,
    severity: str | None = None,
    agent_id: str | None = None,
    span_id: str | None = None,
    session_id: str | None = None,
    user_id: str | None = None,
    blocking: bool = False,
) -> dict[str, Any] | None:
    """Self-report a stumble to Eden (F28).

    Parameters
    ----------
    title
        Short human description ("tool returned empty result").
    kind
        Stumble kind; defaults to ``"self_diagnostic"``. Unknown kinds
        are coerced to ``"self_diagnostic"``.
    trace_id
        Correlates the stumble to a trace. Auto-fills from the active
        :func:`eden.current_trace` when omitted.
    detail
        Arbitrary JSON-safe context (span ids, error text, scores).
    blocking
        When ``True``, POST inline and return the API response. When
        ``False`` (default), fire on a daemon thread and return the
        payload that was queued (or ``None`` if nothing was sent).

    Returns
    -------
    dict | None
        The API response (``blocking=True``), the queued payload
        (``blocking=False``), or ``None`` when the SDK is disabled /
        no ``trace_id`` could be resolved.
    """
    config = get_config()
    if not config.enabled:
        return None

    resolved_kind = kind if kind in _VALID_KINDS else "self_diagnostic"
    resolved_trace = _resolve_trace_id(trace_id)
    if not resolved_trace:
        logger.warning(
            "eden record_stumble: no trace_id (pass trace_id= or call "
            "inside eden.trace()); dropping self-report"
        )
        return None
    if not config.org_id:
        logger.warning("eden record_stumble: org_id not configured; dropping")
        return None

    payload = _build_payload(
        title=title,
        kind=resolved_kind,
        trace_id=resolved_trace,
        detail=detail,
        severity=severity,
        agent_id=agent_id,
        span_id=span_id,
        session_id=session_id,
        user_id=user_id,
    )

    if config.dry_run:
        logger.debug("eden[dry-run] record_stumble %s", payload)
        return payload

    if blocking:
        return _post_stumble(config, payload)

    thread = threading.Thread(
        target=_post_stumble,
        args=(config, payload),
        name="eden-sdk-stumble",
        daemon=True,
    )
    thread.start()
    return payload
