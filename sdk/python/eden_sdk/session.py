"""Agent session SDK (F23) — multi-turn session unit for detection quality."""

from __future__ import annotations

import logging
import uuid
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any

from eden_sdk.config import get_config
from eden_sdk.trace import TraceContext, current_trace, trace

logger = logging.getLogger("eden_sdk.session")

_current_session: dict[str, "AgentSession | None"] = {"value": None}


def current_session() -> "AgentSession | None":
    return _current_session["value"]


@dataclass
class AgentSession(AbstractContextManager["AgentSession"]):
    """F23 session context — groups traces under one session_id."""

    session_id: str
    org_id: str
    agent_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    trace_ids: list[str] = field(default_factory=list)
    _ended: bool = False

    def trace(self, name: str, **kwargs: Any) -> TraceContext:
        """Start a child trace attributed to this session."""
        ctx = trace(name, **kwargs)
        active = current_trace()
        if active is not None:
            active.set_attribute("agent_session_id", self.session_id)
            if self.agent_id:
                active.set_attribute("agent_id", self.agent_id)
            if self.user_id:
                active.set_attribute("user_id", self.user_id)
            self.trace_ids.append(active.trace_id)
        return ctx

    def complete(
        self,
        *,
        success: bool = True,
        failure_reason: str | None = None,
    ) -> None:
        if self._ended:
            return
        self._ended = True
        _notify_session("end", {
            "session_id": self.session_id,
            "org_id": self.org_id,
            "agent_id": self.agent_id,
            "user_id": self.user_id,
            "success": success,
            "failure_reason": failure_reason,
            "trace_ids": list(self.trace_ids),
            "metadata": dict(self.metadata),
        })

    def __enter__(self) -> AgentSession:
        _current_session["value"] = self
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        if exc is not None and not self._ended:
            self.complete(success=False, failure_reason=str(exc))
        elif not self._ended:
            self.complete(success=True)
        _current_session["value"] = None
        return False


def begin(
    *,
    user_id: str | None = None,
    agent_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    session_id: str | None = None,
) -> AgentSession:
    """Start an agent session (context manager or manual complete)."""
    cfg = get_config()
    sid = session_id or str(uuid.uuid4())
    session = AgentSession(
        session_id=sid,
        org_id=cfg.org_id or "default",
        agent_id=agent_id,
        user_id=user_id,
        metadata=dict(metadata or {}),
    )
    client = get_default_client()
    try:
        _notify_session("start", {
            "session_id": session.session_id,
            "org_id": session.org_id,
            "agent_id": agent_id,
            "user_id": user_id,
            "metadata": session.metadata,
        })
    except Exception as exc:
        logger.debug("session.start notify failed: %s", exc)
    return session


def _notify_session(phase: str, payload: dict[str, Any]) -> None:
    """Best-effort HTTP notify for agent session lifecycle."""
    import threading

    def _post() -> None:
        try:
            import httpx

            cfg = get_config()
            if not cfg.org_id or not cfg.base_url:
                return
            base = cfg.base_url.rstrip("/")
            sid = payload.get("session_id", "")
            if phase == "start":
                url = f"{base}/orgs/{cfg.org_id}/agent-sessions/start"
                body = {
                    "agent_id": payload.get("agent_id"),
                    "user_id": payload.get("user_id"),
                    "metadata": payload.get("metadata"),
                    "session_id": sid,
                }
            else:
                url = f"{base}/orgs/{cfg.org_id}/agent-sessions/{sid}/end"
                body = {
                    "success": payload.get("success", True),
                    "failure_reason": payload.get("failure_reason"),
                }
            headers: dict[str, str] = {}
            if cfg.api_key:
                headers["Authorization"] = f"Bearer {cfg.api_key}"
            httpx.post(url, json=body, headers=headers, timeout=5.0)
        except Exception as exc:
            logger.debug("session %s notify failed: %s", phase, exc)

    threading.Thread(target=_post, daemon=True).start()


def complete_session(
    session: AgentSession,
    *,
    success: bool = True,
    failure_reason: str | None = None,
) -> None:
    """Finalize a session started with :func:`begin`."""
    session.complete(success=success, failure_reason=failure_reason)


__all__ = [
    "AgentSession",
    "begin",
    "complete_session",
    "current_session",
]
