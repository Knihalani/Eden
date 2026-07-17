"""SDK live trace publisher — ``stream=True`` / ``EDEN_LIVE=1`` (N11)."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger("eden_sdk.live")

_ENV_LIVE = "EDEN_LIVE"


def live_mode_enabled(*, stream: bool | None = None) -> bool:
    """Return True when live streaming should publish span events."""
    if stream is True:
        return True
    if stream is False:
        return False
    raw = os.getenv(_ENV_LIVE, "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class LiveSpanPublisher:
    """HTTP fallback publisher for in-flight span events."""

    def __init__(self) -> None:
        self._local_buffer: list[dict[str, Any]] = []
        self._max_buffer = 500
        self._dropped = 0

    def publish_event(
        self,
        *,
        session_id: str,
        event: dict[str, Any],
        config: Any | None = None,
    ) -> dict[str, Any]:
        from eden_sdk.config import get_config

        cfg = config or get_config()
        if cfg.disabled or cfg.dry_run:
            self._buffer(event)
            return {"status": "buffered", "reason": "dry_run_or_disabled"}

        if not cfg.org_id:
            self._buffer(event)
            return {"status": "buffered", "reason": "missing_org"}

        url = (
            f"{cfg.base_url.rstrip('/')}/orgs/{cfg.org_id}"
            f"/stream/traces/{session_id}/publish"
        )
        try:
            import httpx

            with httpx.Client(timeout=cfg.timeout_s) as client:
                resp = client.post(url, json=event, headers=cfg.auth_headers())
                if resp.status_code >= 400:
                    self._buffer(event)
                    return {
                        "status": "buffered",
                        "reason": f"http_{resp.status_code}",
                        "dropped": self._dropped,
                    }
                return resp.json() if resp.content else {"status": "ok"}
        except Exception as exc:
            logger.debug("live publish failed, buffering: %s", exc)
            self._buffer(event)
            return {"status": "buffered", "reason": str(exc), "dropped": self._dropped}

    def finalize(
        self,
        *,
        session_id: str,
        trace_id: str | None = None,
        step_count: int | None = None,
        config: Any | None = None,
    ) -> dict[str, Any]:
        from eden_sdk.config import get_config

        cfg = config or get_config()
        if cfg.disabled or cfg.dry_run or not cfg.org_id:
            return {
                "status": "ok",
                "buffered_local": len(self._local_buffer),
                "persisted_once": False,
            }
        url = (
            f"{cfg.base_url.rstrip('/')}/orgs/{cfg.org_id}"
            f"/stream/traces/{session_id}/finalize"
        )
        body = {
            "trace_id": trace_id,
            "step_count": step_count if step_count is not None else len(self._local_buffer),
        }
        try:
            import httpx

            with httpx.Client(timeout=cfg.timeout_s) as client:
                resp = client.post(url, json=body, headers=cfg.auth_headers())
                self._local_buffer.clear()
                return resp.json() if resp.content else {"status": "ok"}
        except Exception as exc:
            logger.debug("live finalize failed: %s", exc)
            return {"status": "error", "error": str(exc)}

    def _buffer(self, event: dict[str, Any]) -> None:
        if len(self._local_buffer) >= self._max_buffer:
            self._dropped += 1
            self._local_buffer.pop(0)
        self._local_buffer.append({**event, "buffered_at": time.time()})


_default_publisher: LiveSpanPublisher | None = None


def get_live_publisher() -> LiveSpanPublisher:
    global _default_publisher
    if _default_publisher is None:
        _default_publisher = LiveSpanPublisher()
    return _default_publisher


def emit_span_live(
    *,
    session_id: str,
    event_type: str,
    span_id: str,
    name: str,
    trace_id: str | None = None,
    parent_id: str | None = None,
    attributes: dict[str, Any] | None = None,
    status: str | None = None,
    stream: bool | None = None,
) -> dict[str, Any] | None:
    if not live_mode_enabled(stream=stream):
        return None
    event: dict[str, Any] = {
        "type": event_type,
        "span_id": span_id,
        "name": name,
        "ts": time.time(),
    }
    if trace_id:
        event["trace_id"] = trace_id
    if parent_id:
        event["parent_id"] = parent_id
    if attributes:
        event["attributes"] = attributes
    if status:
        event["status"] = status
    return get_live_publisher().publish_event(session_id=session_id, event=event)
