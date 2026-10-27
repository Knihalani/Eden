"""wrap_tools: route model tool calls onto compiled tools, fail open.

Mirrors ``packages/sdk-js/src/index.ts``:

1. Before running the original callable, POST ``/v1/wrap``. If the runtime
   answers ``{"action": "play", ...}``, return the compiled facts/text and
   never run the original.
2. On any failure — endpoint down, non-2xx, timeout, malformed body, or
   anything else — fall back to the original callable. The user's call is
   never blocked by Eden.
3. After the original produces its result, record it to ``/v1/ingest`` in a
   daemon thread. Recording is fire-and-forget: a slow or broken runtime can
   neither delay nor break the call that is being recorded (the async-record
   guarantee).

Honesty invariants: ordinary calls never wait on Eden beyond the client's
bounded timeout before falling back, and nothing here can approve anything —
a compiled tool only answers after a human turned it On on the website.
"""

from __future__ import annotations

import functools
import inspect
import threading
import time
import uuid
from typing import Any, Callable

from .client import EdenClient

Original = Callable[[str, dict[str, Any]], Any]

AGENT_ID = "sdk_py"


def _record_async(
    client: EdenClient,
    agent_id: str,
    run_id: str,
    seq: int,
    name: str,
    args: dict[str, Any],
) -> None:
    """Post one ingest event from a daemon thread; swallow everything."""

    def job() -> None:
        try:
            client.ingest(
                agent_id=agent_id,
                run_id=run_id,
                events=[{"event_id": str(uuid.uuid4()), "seq": seq, "name": name, "args": args, "ok": True}],
            )
        except Exception:
            pass  # recording must never break the user's call

    threading.Thread(target=job, name="eden-record", daemon=True).start()


def _try_compiled(client: EdenClient, name: str, args: dict[str, Any], run_id: str) -> tuple[bool, Any]:
    """Return (True, value) when the compiled tool answers, else (False, None).

    Every possible error collapses to (False, None) so callers fall back.
    """
    try:
        res = client.wrap(name, args, run_id)
    except Exception:
        return False, None
    if isinstance(res, dict) and res.get("action") == "play":
        # Mirror sdk-js: facts win, text is the fallback shape.
        value = res.get("facts")
        if value is None:
            value = res.get("text")
        return True, value
    return False, None


def wrap_tools(
    tools: dict[str, Original],
    client: EdenClient,
    *,
    agent_id: str = AGENT_ID,
    run_id: str | None = None,
) -> dict[str, Original]:
    """Wrap a mapping of ``{name: callable(name, args)}``.

    Returns a new mapping of wrapped callables with identical signatures.
    Wrapped callables try the compiled tool first and fall back to the
    original on any failure; recording happens off-thread and can never
    break the call.
    """
    shared_run = run_id or f"sdk-{int(time.time() * 1000)}"
    counters: dict[str, int] = {}
    lock = threading.Lock()

    def next_seq(name: str) -> int:
        with lock:
            counters[name] = counters.get(name, 0) + 1
            return counters[name]

    def make_wrapper(name: str, fn: Original) -> Original:
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(tool_name: str, args: dict[str, Any]) -> Any:
                played, value = _try_compiled(client, name, args, shared_run)
                if played:
                    return value
                result = await fn(tool_name, args)
                _record_async(client, agent_id, shared_run, next_seq(name), name, args)
                return result

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(tool_name: str, args: dict[str, Any]) -> Any:
            played, value = _try_compiled(client, name, args, shared_run)
            if played:
                return value
            result = fn(tool_name, args)
            _record_async(client, agent_id, shared_run, next_seq(name), name, args)
            return result

        return wrapper

    return {name: make_wrapper(name, fn) for name, fn in tools.items()}


__all__ = ["wrap_tools", "AGENT_ID"]
