"""Auto-instrumentation for LangChain.

Registers an Eden callback handler with the global ``CallbackManager``.
LangChain calls every callback on every LLM/chain/tool/agent run, so
this single registration gives us structured spans for the entire
execution tree.

We rely on the modern ``langchain-core`` callback API. The
``BaseCallbackHandler`` class is part of the public surface since
0.1 and is the only stable hook across LCEL, agents, and tools.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Optional

from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import TraceContext, current_trace

logger = logging.getLogger("eden_sdk.instrumentation.langchain")

_handler: Optional["EdenLangChainHandler"] = None


def install() -> None:
    """Register the Eden callback handler globally."""
    global _handler
    if _handler is not None:
        return
    try:
        from langchain_core.callbacks import BaseCallbackHandler
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"langchain-core not importable: {exc}") from exc

    class EdenLangChainHandler(BaseCallbackHandler):  # type: ignore[misc]
        """LangChain callback that emits Eden framework events.

        Every LLM/chain/tool/agent start and end surfaces as one
        framework event with a stable ``run_id`` and a parent link
        (when the run is nested under a chain).
        """

        def __init__(self) -> None:
            self._run_meta: dict[str, dict[str, Any]] = {}
            self._run_starts: dict[str, float] = {}

        # ── LLM events ───────────────────────────────────────────────

        def on_llm_start(
            self,
            serialized: dict[str, Any],
            prompts: list[str],
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            tags: Optional[list[str]] = None,
            metadata: Optional[dict[str, Any]] = None,
            **kwargs: Any,
        ) -> None:
            self._record_start(run_id, parent_run_id, tags, metadata,
                               name=_name_from_serialized(serialized,
                                                          fallback="llm"),
                               kind="llm.start",
                               extra={"prompts": _truncate_list(prompts)})

        def on_llm_end(
            self,
            response: Any,
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            **kwargs: Any,
        ) -> None:
            payload = _safe_llm_response(response)
            self._record_end(run_id, payload=payload, kind="llm.end")

        def on_llm_error(
            self,
            error: BaseException,
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            **kwargs: Any,
        ) -> None:
            self._record_end(run_id, payload={"error": repr(error)},
                             kind="llm.error")

        # ── Chain events ─────────────────────────────────────────────

        def on_chain_start(
            self,
            serialized: dict[str, Any],
            inputs: dict[str, Any],
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            tags: Optional[list[str]] = None,
            metadata: Optional[dict[str, Any]] = None,
            **kwargs: Any,
        ) -> None:
            self._record_start(
                run_id, parent_run_id, tags, metadata,
                name=_name_from_serialized(serialized, fallback="chain"),
                kind="chain.start",
                extra={"input_keys": sorted(inputs.keys())}
                if isinstance(inputs, dict) else None,
            )

        def on_chain_end(
            self,
            outputs: dict[str, Any],
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            **kwargs: Any,
        ) -> None:
            self._record_end(
                run_id,
                payload={"output_keys": sorted(outputs.keys())}
                if isinstance(outputs, dict) else None,
                kind="chain.end",
            )

        def on_chain_error(
            self,
            error: BaseException,
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            **kwargs: Any,
        ) -> None:
            self._record_end(run_id, payload={"error": repr(error)},
                             kind="chain.error")

        # ── Tool events ──────────────────────────────────────────────

        def on_tool_start(
            self,
            serialized: dict[str, Any],
            input_str: str,
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            tags: Optional[list[str]] = None,
            metadata: Optional[dict[str, Any]] = None,
            **kwargs: Any,
        ) -> None:
            self._record_start(
                run_id, parent_run_id, tags, metadata,
                name=_name_from_serialized(serialized, fallback="tool"),
                kind="tool.start",
                extra={"input": input_str[:512]},
            )

        def on_tool_end(
            self,
            output: str,
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            **kwargs: Any,
        ) -> None:
            self._record_end(run_id, payload={"output": str(output)[:512]},
                             kind="tool.end")

        def on_tool_error(
            self,
            error: BaseException,
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            **kwargs: Any,
        ) -> None:
            self._record_end(run_id, payload={"error": repr(error)},
                             kind="tool.error")

        # ── Agent events (modern langchain) ──────────────────────────

        def on_agent_action(
            self,
            action: Any,
            *,
            run_id: Any,
            parent_run_id: Optional[Any] = None,
            **kwargs: Any,
        ) -> None:
            payload = {
                "tool": getattr(action, "tool", None),
                "tool_input": _short(getattr(action, "tool_input", None)),
            }
            self._record_end(run_id, payload=payload, kind="agent.action")

        # ── Internal helpers ────────────────────────────────────────

        def _record_start(
            self,
            run_id: Any,
            parent_run_id: Optional[Any],
            tags: Optional[list[str]],
            metadata: Optional[dict[str, Any]],
            *,
            name: str,
            kind: str,
            extra: Optional[dict[str, Any]] = None,
        ) -> None:
            rid = str(run_id)
            self._run_starts[rid] = time.perf_counter()
            self._run_meta[rid] = {
                "name": name,
                "kind": kind,
                "parent": str(parent_run_id) if parent_run_id else None,
                "tags": list(tags or []),
                "metadata": dict(metadata or {}),
                "extra": extra or {},
            }

        def _record_end(
            self,
            run_id: Any,
            *,
            payload: Optional[dict[str, Any]],
            kind: str,
        ) -> None:
            rid = str(run_id)
            meta = self._run_meta.pop(rid, None)
            t0 = self._run_starts.pop(rid, None)
            if meta is None or t0 is None:
                return
            duration_ms = (time.perf_counter() - t0) * 1000.0
            event: dict[str, Any] = {
                "event_id": f"eden_lc_{rid}",
                "trace_id": (
                    current_trace().trace_id
                    if current_trace() else uuid.uuid4().hex
                ),
                "name": meta["name"],
                "event_type": "framework.callback",
                "agent_id": meta["name"],
                "duration_ms": duration_ms,
                "outcome": (
                    "error" if (payload or {}).get("error") else "success"
                ),
                "attributes": {
                    f"langchain.{k}": str(v)
                    for k, v in {
                        "kind": kind,
                        "tags": ",".join(meta["tags"] or []),
                        "parent_run_id": meta["parent"] or "",
                    }.items()
                },
                "tags": ["langchain", "framework"],
                "source_format": "framework",
                "span_id": rid,
                "parent_span_id": meta["parent"],
            }
            if payload:
                event["attributes"].update(
                    {f"langchain.payload.{k}": _short(v)
                     for k, v in payload.items()}
                )
            cfg = get_config()
            if cfg.enabled:
                get_default_client().enqueue(
                    TraceEvent(payload=event, source_format="framework")
                )

    _handler = EdenLangChainHandler()
    # Best-effort: install globally. LangChain's ``set_handler`` was the
    # 0.0-era API; modern code uses ``CallbackManager([handler])``. We
    # register the handler in two places for safety:
    # 1) Set as the global default so libraries that read it pick it up.
    # 2) Append to the default manager's handlers list.
    try:
        from langchain_core.callbacks import set_handler, get_callback_manager  # type: ignore
    except Exception:  # noqa: BLE001
        set_handler = None  # type: ignore
        get_callback_manager = None  # type: ignore
    if set_handler is not None:
        try:
            set_handler(_handler)
        except Exception:  # noqa: BLE001
            pass
    if get_callback_manager is not None:
        try:
            mgr = get_callback_manager()
            if _handler not in getattr(mgr, "handlers", []):
                mgr.add_handler(_handler)
        except Exception:  # noqa: BLE001
            pass

    logger.debug("eden: langchain BaseCallbackHandler registered")


def uninstall() -> None:
    global _handler
    if _handler is None:
        return
    try:
        from langchain_core.callbacks import get_callback_manager  # type: ignore
        mgr = get_callback_manager()
        mgr.remove_handler(_handler)
    except Exception:  # noqa: BLE001
        pass
    _handler = None


# ── Helpers ───────────────────────────────────────────────────────────


def _name_from_serialized(serialized: Optional[dict[str, Any]],
                          fallback: str) -> str:
    if not isinstance(serialized, dict):
        return fallback
    name = serialized.get("name")
    if isinstance(name, str) and name:
        return name
    return fallback


def _safe_llm_response(response: Any) -> dict[str, Any]:
    """Return a small, JSON-safe summary of an LLMResult."""
    out: dict[str, Any] = {"kind": "llm_response"}
    try:
        llm_output = getattr(response, "llm_output", None)
        if llm_output:
            out["token_usage"] = llm_output.get("token_usage")
        gens = getattr(response, "generations", None)
        if gens:
            first_chain = gens[0] or []
            if first_chain:
                first = first_chain[0]
                text = getattr(first, "text", None)
                if text:
                    out["first_text"] = text[:512]
    except Exception:  # noqa: BLE001
        pass
    return out


def _short(value: Any, max_len: int = 256) -> str:
    try:
        s = repr(value)
    except Exception:  # noqa: BLE001
        s = f"<unrepr {type(value).__name__}>"
    if len(s) > max_len:
        s = s[: max_len - 1] + "…"
    return s


def _truncate_list(items: list[str], max_len: int = 512) -> list[str]:
    return [str(x)[:max_len] for x in items]
