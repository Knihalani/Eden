"""Agent session SDK (F23) — multi-turn session unit for detection quality."""

from __future__ import annotations

import logging
import uuid
from contextlib import AbstractContextManager
from contextvars import ContextVar
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any

from eden_sdk.client import get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import TraceContext, current_trace, trace

logger = logging.getLogger("eden_sdk.session")

_current_session: ContextVar["AgentSession | None"] = ContextVar(
    "eden_current_session", default=None
)


def current_session() -> "AgentSession | None":
    return _current_session.get()


@dataclass
class AgentSession(AbstractContextManager["AgentSession"]):
    """F23 session context — groups traces under one session_id."""

    session_id: str
    org_id: str
    agent_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    trace_ids: list[str] = field(default_factory=list)
    cost_usd: float = 0.0
    _ended: bool = False
    _token: Any = field(default=None, repr=False)

    def identify(self, user_id: str) -> None:
        """Attach ``user_id`` to this session (local + ingest notify)."""
        self.user_id = user_id
        _notify_session(
            "identify",
            {
                "session_id": self.session_id,
                "org_id": self.org_id,
                "user_id": user_id,
            },
        )

    def add_cost(self, amount_usd: float) -> None:
        if amount_usd and amount_usd > 0:
            self.cost_usd += float(amount_usd)

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
            _notify_session(
                "attach_trace",
                {
                    "session_id": self.session_id,
                    "org_id": self.org_id,
                    "trace_id": active.trace_id,
                },
            )
        return ctx

    def complete(
        self,
        *,
        success: bool = True,
        failure_reason: str | None = None,
        flush: bool = True,
    ) -> None:
        if self._ended:
            return
        self._ended = True
        _notify_session(
            "end",
            {
                "session_id": self.session_id,
                "org_id": self.org_id,
                "agent_id": self.agent_id,
                "user_id": self.user_id,
                "success": success,
                "failure_reason": failure_reason,
                "trace_ids": list(self.trace_ids),
                "metadata": dict(self.metadata),
                "cost_usd": self.cost_usd,
            },
        )
        if flush:
            try:
                get_default_client().flush(timeout=2.0)
            except Exception as exc:  # noqa: BLE001
                logger.debug("session.flush failed: %s", exc)
        if current_session() is self:
            _current_session.set(None)

    def __enter__(self) -> AgentSession:
        self._token = _current_session.set(self)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        if exc is not None and not self._ended:
            self.complete(success=False, failure_reason=str(exc), flush=True)
        elif not self._ended:
            self.complete(success=True, flush=True)
        if self._token is not None:
            try:
                _current_session.reset(self._token)
            except Exception:  # noqa: BLE001
                pass
            self._token = None
        # begin() may have set the ContextVar before __enter__; reset
        # alone can restore that value — always clear after exit.
        if current_session() is self:
            _current_session.set(None)
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
    _current_session.set(session)
    try:
        _notify_session(
            "start",
            {
                "session_id": session.session_id,
                "org_id": session.org_id,
                "agent_id": agent_id,
                "user_id": user_id,
                "metadata": session.metadata,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("session.start notify failed: %s", exc)
    return session


def identify(user_id: str, *, session: AgentSession | None = None) -> None:
    """Identify the current (or given) session with a user_id."""
    target = session or current_session()
    if target is None:
        logger.warning("eden identify: no active session")
        return
    target.identify(user_id)


def _notify_session(phase: str, payload: dict[str, Any]) -> None:
    """Best-effort HTTP notify for agent session lifecycle (ingest path)."""
    import threading

    def _post() -> None:
        try:
            import httpx

            cfg = get_config()
            if not cfg.org_id or not cfg.base_url:
                return
            base = cfg.base_url.rstrip("/")
            sid = payload.get("session_id", "")
            root = f"{base}/orgs/{cfg.org_id}/ingest/agent-sessions"
            if phase == "start":
                url = f"{root}/start"
                body = {
                    "agent_id": payload.get("agent_id"),
                    "user_id": payload.get("user_id"),
                    "metadata": payload.get("metadata"),
                    "session_id": sid,
                }
            elif phase == "identify":
                url = f"{root}/{sid}/identify"
                body = {"user_id": payload.get("user_id")}
            elif phase == "attach_trace":
                url = f"{root}/{sid}/traces"
                body = {"trace_id": payload.get("trace_id")}
            else:
                url = f"{root}/{sid}/end"
                body = {
                    "success": payload.get("success", True),
                    "failure_reason": payload.get("failure_reason"),
                    "cost_usd": payload.get("cost_usd"),
                    "trace_ids": payload.get("trace_ids"),
                }
            headers = cfg.auth_headers()
            headers.setdefault("Content-Type", "application/json")
            resp = httpx.post(url, json=body, headers=headers, timeout=5.0)
            if resp.status_code >= 400:
                logger.warning(
                    "session %s notify returned %s: %s",
                    phase,
                    resp.status_code,
                    resp.text[:200],
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("session %s notify failed: %s", phase, exc)

    threading.Thread(target=_post, daemon=True, name="eden-sdk-session").start()


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
    "identify",
]
