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
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Any, Optional

from eden_sdk._instrumentation_ids import _trace_id_or_random
from eden_sdk._tokens import extract_usage, normalize_model_name
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config
from eden_sdk.trace import current_trace

logger = logging.getLogger("eden_sdk.instrumentation.langchain")


_handler: Optional["EdenLangChainHandler"] = None  # type: ignore[name-defined]  # noqa: F821,UP037,UP045
_handler_var: ContextVar[Any | None] = ContextVar(
    "eden_langchain_handler", default=None
)
_configure_hook_registered = False


def install() -> None:
    """Register the Eden callback handler globally."""
    global _handler, _configure_hook_registered
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
            # Per-run streaming state. Initialised by
            # ``on_llm_start`` for an LLM run and consumed by
            # ``on_llm_new_token`` (one entry per token) +
            # ``on_llm_end`` / ``on_llm_error`` (final
            # cleanup). The buffer list is appended to
            # ``client._chunk_buffer`` directly so the existing
            # sender thread flushes it on its next tick — same
            # pattern the OpenAI + Anthropic streaming
            # instrumentations use.
            self._stream_state: dict[str, dict[str, Any]] = {}

        # ── LLM events ───────────────────────────────────────────────

        def on_llm_start(
            self,
            serialized: dict[str, Any],
            prompts: list[str],
            *,
            run_id: Any,
            parent_run_id: Any | None = None,
            tags: list[str] | None = None,
            metadata: dict[str, Any] | None = None,
            **kwargs: Any,
        ) -> None:
            self._record_start(run_id, parent_run_id, tags, metadata,
                               name=_name_from_serialized(serialized,
                                                          fallback="llm"),
                               kind="llm.start",
                               extra={"prompts": _truncate_list(prompts)})
            # Seed the per-run streaming state so the first
            # ``on_llm_new_token`` has TTFT reference + a
            # trace_id to use on the per-chunk buffer. The
            # state is keyed by ``run_id`` (str) so concurrent
            # streams don't clobber each other; ``on_llm_end``
            # pops it. The same trace_id the framework event
            # gets is reused on the per-chunk events so the
            # gateway can join them.
            import uuid as _uuid
            rid = str(run_id)
            self._stream_state[rid] = {
                "trace_id": _trace_id_or_random(),
                "stream_event_id": f"stream_langchain_{_uuid.uuid4().hex[:16]}",
                # ``t_start`` is the per-run start time
                # (captured in ``on_llm_start``). The
                # ``on_llm_new_token`` callback uses it as the
                # reference for ``ttft_ms`` (time from start
                # of the LLM call to the first token).
                "t_start": time.perf_counter(),
                "t_first": None,
                "t_prev": None,
                "t_last": time.perf_counter(),
                "chunk_count": 0,
                "output_tokens": 0,
                "usage_input": None,
                "usage_output": None,
                "usage_cache_read": None,
                "usage_cache_write": None,
                "model": None,
            }

        def on_llm_new_token(
            self,
            token: str,
            *,
            run_id: Any,
            parent_run_id: Any | None = None,
            chunk: Any | None = None,
            **kwargs: Any,
        ) -> None:
            # Streaming-token callback. Modern LangChain (0.1+)
            # surfaces the per-chunk ``AIMessageChunk`` (with
            # ``usage_metadata`` + ``response_metadata``) on
            # the ``chunk`` kwarg; older versions only pass
            # the token string. We extract whatever is
            # available and push a ``StreamChunk``-shaped dict
            # to ``client._chunk_buffer`` so the per-chunk
            # TTFT / ITL / TPOT dashboards render for
            # LangChain streams (parity with the OpenAI +
            # Anthropic streaming instrumentations). Without
            # this, the per-chunk dashboards were empty for
            # every LangChain stream and the framework event
            # had no model / input_tokens on the wire.
            rid = str(run_id)
            state = self._stream_state.get(rid)
            if state is None:
                # ``on_llm_new_token`` fired without a prior
                # ``on_llm_start`` (rare but possible with
                # custom callback wiring). Skip — without the
                # seed state we can't compute TTFT or push a
                # well-formed chunk.
                return
            now = time.perf_counter()
            t_first = state["t_first"]
            t_prev = state["t_prev"]
            chunk_count = state["chunk_count"] + 1
            output_tokens = state["output_tokens"] + max(
                1, (len(token) + 3) // 4
            )
            # Capture the interval to the previous chunk
            # BEFORE updating ``t_prev`` — otherwise the
            # per-chunk ITL/TPOT readings collapse to 0 for
            # tokens that share a tick. Mirrors the OpenAI +
            # Anthropic streaming paths.
            prev = t_prev
            if t_first is None:
                t_first = now
            t_last = now
            # Extract usage + model from the modern
            # ``AIMessageChunk`` if the framework supplied
            # one. Older LangChain versions only pass the
            # token string — the dict lookups are defensive
            # no-ops in that case.
            usage_meta = getattr(chunk, "usage_metadata", None) or (
                chunk.get("usage_metadata") if isinstance(chunk, dict) else None
            )
            if usage_meta is not None and isinstance(usage_meta, Mapping):
                u = extract_usage(usage_meta)
                if u["input_tokens"] is not None:
                    state["usage_input"] = u["input_tokens"]
                if u["output_tokens"] is not None:
                    state["usage_output"] = u["output_tokens"]
                    output_tokens = u["output_tokens"]
                if u["cache_read_tokens"] is not None:
                    state["usage_cache_read"] = u["cache_read_tokens"]
                if u["cache_creation_tokens"] is not None:
                    state["usage_cache_write"] = u["cache_creation_tokens"]
            response_meta = (
                getattr(chunk, "response_metadata", None)
                if chunk is not None and not isinstance(chunk, dict)
                else (chunk.get("response_metadata") if isinstance(chunk, dict) else None)
            )
            if response_meta is not None and isinstance(response_meta, Mapping):
                m = response_meta.get("model_name") or response_meta.get("model")
                if isinstance(m, str) and state["model"] is None:
                    state["model"] = m
            # Per-chunk TPOT (time per output token) is the
            # time spent generating THIS chunk's tokens
            # divided by the token count for this chunk
            # (approximated as ``ceil(len/4)`` to match the
            # aggregate ``output_tokens`` heuristic).
            tpot_ms = None
            if token and prev is not None and now > prev:
                tpot_ms = ((now - prev) * 1000.0) / max(
                    1, (len(token) + 3) // 4
                )
            client = get_default_client()
            buffer = (
                client._chunk_buffer
                if getattr(client, "_chunk_buffer", None) is not None
                else None
            )
            if buffer is not None:
                chunk_row = {
                    "event_id": state["stream_event_id"],
                    "trace_id": state["trace_id"],
                    "chunk_index": chunk_count - 1,
                    "delta_text": token if bool(getattr(client.config, "capture_chunk_text", False)) else None,
                    "ttft_ms": ((t_first - state.get("t_start", now)) * 1000.0)
                    if t_first is not None
                    else None,
                    "itl_ms": ((now - prev) * 1000.0) if prev is not None else None,
                    "tpot_ms": tpot_ms,
                    "received_at_client_ms": int(time.time() * 1000),
                }
                buffer.append(chunk_row)
            # Persist the updated counters back into state
            # so the next token (and ``on_llm_end``) see them.
            state["t_first"] = t_first
            state["t_prev"] = now
            state["t_last"] = t_last
            state["chunk_count"] = chunk_count
            state["output_tokens"] = output_tokens

        def on_llm_end(
            self,
            response: Any,
            *,
            run_id: Any,
            parent_run_id: Any | None = None,
            **kwargs: Any,
        ) -> None:
            payload = _safe_llm_response(response)
            # Hoist the per-run streaming state (extracted
            # from ``on_llm_new_token``'s chunks) onto the
            # aggregate event so pricing lookups can roll up
            # the input_tokens / cache_read / model that the
            # previous implementation never surfaced on the
            # wire. Without this, the framework event had no
            # model or input_tokens even when the streaming
            # callback captured them.
            rid = str(run_id)
            state = self._stream_state.pop(rid, None)
            if state is not None:
                if state.get("usage_input") is not None:
                    payload.setdefault("input_tokens", state["usage_input"])
                if state.get("usage_output") is not None:
                    payload.setdefault("output_tokens", state["usage_output"])
                if state.get("usage_cache_read") is not None:
                    payload.setdefault(
                        "cache_read_input_tokens", state["usage_cache_read"]
                    )
                if state.get("usage_cache_write") is not None:
                    payload.setdefault(
                        "cache_creation_input_tokens", state["usage_cache_write"]
                    )
                if state.get("model"):
                    payload.setdefault("model", state["model"])
                # Reuse the stream's trace_id so /ingest/chunks rows
                # join the framework event (``WHERE trace_id = ?``).
                if state.get("trace_id"):
                    payload["trace_id"] = state["trace_id"]
            self._record_end(run_id, payload=payload, kind="llm.end")

        def on_llm_error(
            self,
            error: BaseException,
            *,
            run_id: Any,
            parent_run_id: Any | None = None,
            **kwargs: Any,
        ) -> None:
            # Drop the streaming state on error too — without
            # this a stream that errors mid-flight would leak
            # the per-run dict forever. The chunks already
            # pushed to ``client._chunk_buffer`` still ship
            # (the client thread doesn't know about the
            # error); we just stop accumulating.
            state = self._stream_state.pop(str(run_id), None)
            err_payload: dict[str, Any] = {"error": repr(error)}
            if state and state.get("trace_id"):
                err_payload["trace_id"] = state["trace_id"]
            self._record_end(run_id, payload=err_payload, kind="llm.error")

        # ── Chain events ─────────────────────────────────────────────

        def on_chain_start(
            self,
            serialized: dict[str, Any],
            inputs: dict[str, Any],
            *,
            run_id: Any,
            parent_run_id: Any | None = None,
            tags: list[str] | None = None,
            metadata: dict[str, Any] | None = None,
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
            parent_run_id: Any | None = None,
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
            parent_run_id: Any | None = None,
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
            parent_run_id: Any | None = None,
            tags: list[str] | None = None,
            metadata: dict[str, Any] | None = None,
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
            parent_run_id: Any | None = None,
            **kwargs: Any,
        ) -> None:
            self._record_end(run_id, payload={"output": str(output)[:512]},
                             kind="tool.end")

        def on_tool_error(
            self,
            error: BaseException,
            *,
            run_id: Any,
            parent_run_id: Any | None = None,
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
            parent_run_id: Any | None = None,
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
            parent_run_id: Any | None,
            tags: list[str] | None,
            metadata: dict[str, Any] | None,
            *,
            name: str,
            kind: str,
            extra: dict[str, Any] | None = None,
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
            payload: dict[str, Any] | None,
            kind: str,
        ) -> None:
            rid = str(run_id)
            meta = self._run_meta.pop(rid, None)
            t0 = self._run_starts.pop(rid, None)
            if meta is None or t0 is None:
                return
            duration_ms = (time.perf_counter() - t0) * 1000.0
            # Prefer the stream-seeded trace_id (when present) so
            # per-chunk events and the aggregate framework event
            # share one join key. Fall back to the active
            # ``eden.trace()`` context / a fresh id otherwise.
            stream_tid = (payload or {}).get("trace_id")
            event: dict[str, Any] = {
                "event_id": f"eden_lc_{rid}",
                "trace_id": (
                    stream_tid
                    if isinstance(stream_tid, str) and stream_tid
                    else _trace_id_or_random()
                ),
                "name": meta["name"],
                "event_type": "agent.run",
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
                     for k, v in payload.items()
                     if k != "trace_id"}
                )
                # Hoist billing-critical fields to the top level so the
                # server-side normalizer can roll them up into
                # ``usage_events`` without walking nested attributes.
                # ``model`` was previously missing from the hoist
                # list — the payload dict had it (via
                # ``_safe_llm_response``'s ``response_metadata`` walk)
                # but the framework event only carried
                # ``model_normalized``. Without ``model`` on the wire,
                # the portal's framework-event view showed
                # ``unknown`` for every LangChain LLM run. Hoist
                # both forms so callers can see the raw provider
                # model id AND the pricing-keyed normalised form.
                for key in ("input_tokens", "output_tokens",
                            "cache_read_input_tokens",
                            "cache_creation_input_tokens",
                            "model", "model_normalized"):
                    if key in payload:
                        event[key] = payload[key]
            cfg = get_config()
            if cfg.enabled:
                get_default_client().enqueue(
                    TraceEvent(payload=event, source_format="framework")
                )

    _handler = EdenLangChainHandler()
    registered = False

    # Modern langchain-core (0.1+): ``set_handler`` / ``get_callback_manager``
    # were removed. Global handlers attach via ``register_configure_hook`` so
    # every ``CallbackManager.configure()`` picks them up.
    try:
        from langchain_core.tracers.context import register_configure_hook
    except Exception:  # noqa: BLE001
        register_configure_hook = None  # type: ignore[assignment]
    if register_configure_hook is not None:
        try:
            _handler_var.set(_handler)
            if not _configure_hook_registered:
                register_configure_hook(_handler_var, inheritable=True)
                _configure_hook_registered = True
            registered = True
        except Exception as exc:  # noqa: BLE001
            _handler = None
            try:
                _handler_var.set(None)
            except Exception:  # noqa: BLE001
                pass
            raise RuntimeError(
                f"eden: failed to register langchain configure hook: {exc}"
            ) from exc

    # Legacy 0.0-era APIs still used by some test fakes / older installs.
    try:
        from langchain_core.callbacks import get_callback_manager, set_handler  # type: ignore
    except Exception:  # noqa: BLE001
        set_handler = None  # type: ignore
        get_callback_manager = None  # type: ignore
    if set_handler is not None:
        try:
            set_handler(_handler)
            registered = True
        except Exception as exc:  # noqa: BLE001
            logger.debug("eden: langchain set_handler failed: %s", exc)
    if get_callback_manager is not None:
        try:
            mgr = get_callback_manager()
            if _handler not in getattr(mgr, "handlers", []):
                mgr.add_handler(_handler)
            registered = True
        except Exception as exc:  # noqa: BLE001
            logger.debug("eden: langchain get_callback_manager failed: %s", exc)

    if not registered:
        _handler = None
        raise RuntimeError(
            "eden: langchain-core is importable but no global callback "
            "registration API is available (neither "
            "langchain_core.tracers.context.register_configure_hook nor "
            "set_handler/get_callback_manager). Upgrade langchain-core or "
            "pass the Eden handler via RunnableConfig(callbacks=[...])."
        )

    logger.debug("eden: langchain BaseCallbackHandler registered")


def uninstall() -> None:
    global _handler
    if _handler is None:
        return
    try:
        _handler_var.set(None)
    except Exception:  # noqa: BLE001
        pass
    try:
        from langchain_core.callbacks import get_callback_manager  # type: ignore
        mgr = get_callback_manager()
        mgr.remove_handler(_handler)
    except Exception:  # noqa: BLE001
        pass
    _handler = None


# ── Helpers ───────────────────────────────────────────────────────────


def _name_from_serialized(serialized: dict[str, Any] | None,
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
            tu = llm_output.get("token_usage")
            out["token_usage"] = tu
            # Promote to top-level usage fields so the server-side
            # normalizer can roll them up into billing-grade
            # usage_events without needing to know about LangChain's
            # nested ``token_usage`` shape.
            if isinstance(tu, Mapping):
                u = extract_usage(tu)
                if u["input_tokens"] is not None:
                    out["input_tokens"] = u["input_tokens"]
                if u["output_tokens"] is not None:
                    out["output_tokens"] = u["output_tokens"]
            # Modern LangChain chains stash the model name in
            # ``response_metadata``; emit both raw + normalized so
            # pricing lookups hit a single row.
            meta = getattr(response, "response_metadata", None) or {}
            if isinstance(meta, Mapping):
                for key in ("model_name", "model", "model_id"):
                    m = meta.get(key)
                    if isinstance(m, str):
                        out["model"] = m
                        out["model_normalized"] = normalize_model_name(m)
                        break
        gens = getattr(response, "generations", None)
        if gens:
            first_chain = gens[0] or []
            if first_chain:
                first = first_chain[0]
                text = getattr(first, "text", None)
                if text:
                    out["first_text"] = text[:512]
        # Modern LangChain (0.1+) attaches ``usage_metadata`` to
        # the ``AIMessage`` on each generation, NOT to the
        # ``LLMResult.llm_output`` (which only carries the legacy
        # ``token_usage``). The previous implementation never
        # walked the generations, so non-streaming LangChain calls
        # for modern chains had no ``input_tokens`` /
        # ``cache_read_input_tokens`` / ``cache_creation_input_tokens``
        # on the wire — pricing roll-ups missed every modern
        # chain. Walk the generations and merge usage +
        # response_metadata using ``setdefault`` so the legacy
        # path (which wins on older LangChain versions) is not
        # clobbered.
        if gens:
            for chain_gens in gens:
                if not chain_gens:
                    continue
                for gen in chain_gens:
                    if gen is None:
                        continue
                    # ``gen.message`` is the modern AIMessage
                    # shape. Fall back to the generation itself
                    # for older LangChain where generation_info
                    # held the metadata.
                    msg = getattr(gen, "message", None) or gen
                    usage_meta = getattr(msg, "usage_metadata", None)
                    if usage_meta is None and isinstance(msg, Mapping):
                        usage_meta = msg.get("usage_metadata")
                    if isinstance(usage_meta, Mapping):
                        u = extract_usage(usage_meta)
                        if "input_tokens" not in out and u["input_tokens"] is not None:
                            out["input_tokens"] = u["input_tokens"]
                        if "output_tokens" not in out and u["output_tokens"] is not None:
                            out["output_tokens"] = u["output_tokens"]
                        if "cache_read_input_tokens" not in out and u["cache_read_tokens"] is not None:
                            out["cache_read_input_tokens"] = u["cache_read_tokens"]
                        if "cache_creation_input_tokens" not in out and u["cache_creation_tokens"] is not None:
                            out["cache_creation_input_tokens"] = u["cache_creation_tokens"]
                    # Per-generation ``response_metadata`` is
                    # where modern LangChain stashes the model
                    # name when ``LLMResult.response_metadata`` is
                    # empty (a common case for chat models).
                    response_meta = getattr(msg, "response_metadata", None)
                    if response_meta is None and isinstance(msg, Mapping):
                        response_meta = msg.get("response_metadata")
                    if isinstance(response_meta, Mapping) and "model" not in out:
                        for key in ("model_name", "model", "model_id"):
                            m = response_meta.get(key)
                            if isinstance(m, str):
                                out["model"] = m
                                out["model_normalized"] = normalize_model_name(m)
                                break
                    # One generation is enough — subsequent
                    # generations share the same model and the
                    # usage totals are already merged by LangChain
                    # when the API returns them per-request.
                    if (
                        "input_tokens" in out
                        or "output_tokens" in out
                        or "model" in out
                    ):
                        break
                else:
                    continue
                break
    except Exception as exc:  # noqa: BLE001
        # Surface extraction failures at DEBUG so users can opt
        # into seeing them without the SDK spamming warnings by
        # default. The summary dict stays usable; we just may not
        # have ``token_usage`` / ``model`` populated.
        logger.debug(
            "eden: langchain LLMResult summary extraction failed: %s",
            exc,
        )
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
