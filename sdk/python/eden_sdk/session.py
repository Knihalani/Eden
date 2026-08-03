"""Agent session SDK (F23) — multi-turn session unit for detection quality."""

from __future__ import annotations

import concurrent.futures
import gzip
import json
import logging
import os
import threading
import uuid
from contextlib import AbstractContextManager
from contextvars import ContextVar
from dataclasses import dataclass, field
from types import TracebackType
from typing import TYPE_CHECKING, Any

from eden_sdk.client import get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import TraceContext, current_trace, trace

if TYPE_CHECKING:
    import httpx

logger = logging.getLogger("eden_sdk.session")

_current_session: ContextVar[AgentSession | None] = ContextVar(
    "eden_current_session", default=None
)

# ── Shared transport for lifecycle notifies ─────────────────────────
#
# ``_notify_session`` used to open a brand-new ``httpx`` connection
# (via the module-level ``httpx.post``) AND spawn a brand-new OS
# thread on every single ``begin``/``identify``/``complete`` call.
# For agents that run many short-lived sessions per process (a common
# pattern for batch/eval harnesses), that is a fresh TCP+TLS handshake
# and a fresh thread per lifecycle event instead of a handful of
# pooled connections and a couple of long-lived worker threads.
#
# A small thread pool + one lazily-built, process-wide ``httpx.Client``
# fixes both: the client keeps a keep-alive connection pool (mirrors
# ``EdenClient``'s ``httpx.AsyncClient`` pool in ``client.py``), and
# the pool caps concurrent lifecycle notifies without a thread per call.
_SESSION_HTTP_LOCK = threading.Lock()
_session_http_client: httpx.Client | None = None
_SESSION_EXECUTOR_LOCK = threading.Lock()
_session_executor: concurrent.futures.ThreadPoolExecutor | None = None

#: Small pool — lifecycle notifies are infrequent relative to trace
#: events (which go through the batched ``EdenClient`` instead), so a
#: handful of workers is enough to keep ``wait=True`` calls (start/
#: identify/end) from queueing behind each other under moderate
#: concurrency without spinning up unbounded threads.
_SESSION_EXECUTOR_MAX_WORKERS = 4


def _get_session_http_client() -> httpx.Client:
    """Lazily build (once) the pooled sync client used for lifecycle notifies."""
    global _session_http_client
    if _session_http_client is not None:
        return _session_http_client
    with _SESSION_HTTP_LOCK:
        if _session_http_client is None:
            import httpx

            _session_http_client = httpx.Client(
                timeout=5.0,
                limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
            )
    return _session_http_client


def _get_session_executor() -> concurrent.futures.ThreadPoolExecutor:
    """Lazily build (once) the small worker pool for lifecycle notifies."""
    global _session_executor
    if _session_executor is not None:
        return _session_executor
    with _SESSION_EXECUTOR_LOCK:
        if _session_executor is None:
            _session_executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=_SESSION_EXECUTOR_MAX_WORKERS,
                thread_name_prefix="eden-sdk-session",
            )
    return _session_executor


def _reset_session_transport_after_fork() -> None:
    """Rebuild the pooled client/executor in a forked child.

    Mirrors ``EdenClient``'s ``_reset_after_fork`` (``client.py``): an
    ``httpx.Client``'s sockets and the executor's worker threads do not
    survive ``fork()`` — only the calling thread does — so both must be
    dropped and lazily rebuilt in the child rather than reused.
    """
    global _session_http_client, _session_executor
    with _SESSION_HTTP_LOCK:
        if _session_http_client is not None:
            try:
                _session_http_client.close()
            except Exception:  # noqa: BLE001
                pass
        _session_http_client = None
    with _SESSION_EXECUTOR_LOCK:
        # Do not call .shutdown() on the inherited executor: its worker
        # threads did not survive the fork, and joining threads that no
        # longer exist in this process is at best a no-op and at worst
        # a hang. Just drop the reference so a fresh pool is built
        # on-demand.
        _session_executor = None


if hasattr(os, "register_at_fork"):  # POSIX only; absent on Windows
    os.register_at_fork(after_in_child=_reset_session_transport_after_fork)


def current_session() -> AgentSession | None:
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
            wait=True,
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
            wait=True,
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
            wait=True,
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


#: Match ``EdenClient``'s compact JSON separators — fewer bytes to
#: gzip, faster dumps (``client.py``'s ``_JSON_SEPARATORS``).
_JSON_SEPARATORS = (",", ":")


def _notify_session(
    phase: str,
    payload: dict[str, Any],
    *,
    wait: bool = False,
) -> None:
    """Best-effort HTTP notify for agent session lifecycle (ingest path).

    Reuses a pooled ``httpx.Client`` and a small shared thread pool
    (see the module-level ``_get_session_http_client`` /
    ``_get_session_executor``) instead of opening a fresh connection
    and spawning a fresh OS thread on every call.

    ``wait=True`` blocks (bounded, 6s) on the submitted pool job (used
    for ``start``, ``identify``, and ``end``). Fire-and-forget left a
    race where ``end`` could finish before ``start`` persisted the row
    — the API answered 200 ``not_found`` and the later start left
    ``success`` NULL forever. Attach-trace notifies stay async
    (``wait=False``) so they never add latency to the user's call.
    """

    def _post() -> None:
        try:
            cfg = get_config()
            if not cfg.org_id or not cfg.base_url:
                return
            base = cfg.base_url.rstrip("/")
            sid = payload.get("session_id", "")
            root = f"{base}/orgs/{cfg.org_id}/ingest/agent-sessions"
            if phase == "start":
                url = f"{root}/start"
                body: dict[str, Any] = {
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
            # Gzip like the main ingest path (``client.py``'s
            # ``_send_format``) — these bodies are small but a bursty
            # ``end`` with a long ``trace_ids`` list is still worth
            # compressing, and the server (``GunzipRequestMiddleware``)
            # always accepts either encoding, so there's no case where
            # this is wrong, only sometimes not worth the CPU. gzip's
            # own header/footer overhead (~20 bytes) means it is never
            # a net loss even for the smallest bodies here.
            raw = json.dumps(
                body, default=str, separators=_JSON_SEPARATORS
            ).encode("utf-8")
            compressed = gzip.compress(raw, compresslevel=1)
            headers["Content-Encoding"] = "gzip"
            client = _get_session_http_client()
            resp = client.post(url, content=compressed, headers=headers, timeout=5.0)
            if resp.status_code >= 400:
                logger.warning(
                    "session %s notify returned %s: %s",
                    phase,
                    resp.status_code,
                    resp.text[:200],
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("session %s notify failed: %s", phase, exc)

    future = _get_session_executor().submit(_post)
    if wait:
        try:
            future.result(timeout=6.0)
        except concurrent.futures.TimeoutError:
            # Best-effort: the job keeps running in the pool; the
            # caller (start/identify/end) proceeds rather than hang.
            logger.debug("session %s notify timed out after 6s", phase)
        except Exception:  # noqa: BLE001
            # _post() already caught and logged its own exceptions;
            # this only guards against something escaping that try
            # block (e.g. a bug in the logging call itself).
            pass


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
