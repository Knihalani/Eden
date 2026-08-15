"""Gateway-native optimizations for /gateway/v1 chat completions.

Exact response cache, in-flight coalescing, and provider prompt-cache
layout. Each feature defaults ON and can be opted out per request.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Any

from eden.storage.redis import get_redis_client
from eden.util.jsonx import dumps as json_dumps
from eden.util.jsonx import loads as json_loads

logger = logging.getLogger(__name__)

# Wire headers (opt-out: send "false")
HEADER_EXACT_CACHE = "X-Eden-Exact-Cache"
HEADER_COALESCE = "X-Eden-Coalesce"
HEADER_PROVIDER_CACHE_LAYOUT = "X-Eden-Provider-Cache-Layout"
HEADER_RESPONSE_REPAIR = "X-Eden-Response-Repair"

BODY_EXACT_CACHE = "eden_exact_cache"
BODY_COALESCE = "eden_coalesce"
BODY_PROVIDER_CACHE_LAYOUT = "eden_provider_cache_layout"
BODY_RESPONSE_REPAIR = "eden_response_repair"

_EXACT_CACHE_PREFIX = "eden:gw:exact"
_EXACT_CACHE_TTL = 3600

_TRUTHY = frozenset({"1", "true", "yes", "on"})
_FALSY = frozenset({"0", "false", "no", "off"})


@dataclass(frozen=True)
class OptimizationFlags:
    exact_cache: bool = True
    coalesce: bool = True
    provider_cache_layout: bool = True
    response_repair: bool = True


@dataclass
class _InflightEntry:
    future: asyncio.Future
    created_at: float


class GatewayCoalescer:
    """Deduplicate concurrent identical gateway chat requests."""

    def __init__(self, window_ms: float = 250.0) -> None:
        self.window_ms = window_ms
        self._inflight: dict[str, _InflightEntry] = {}
        self._lock = asyncio.Lock()
        self.coalesced_count = 0

    async def execute(
        self,
        key: str,
        call_fn,
    ) -> tuple[Any, bool]:
        """Run *call_fn* once per *key* within the coalesce window.

        Returns ``(result, was_coalesced)``.
        """
        async with self._lock:
            now = time.time()
            expired = [
                k
                for k, v in self._inflight.items()
                if (now - v.created_at) * 1000 > self.window_ms
            ]
            for k in expired:
                entry = self._inflight.pop(k, None)
                if entry and not entry.future.done():
                    entry.future.cancel()

            if key in self._inflight:
                self.coalesced_count += 1
                future = self._inflight[key].future
                try:
                    result = await future
                    return result, True
                except asyncio.CancelledError:
                    raise

            loop = asyncio.get_running_loop()
            future = loop.create_future()
            self._inflight[key] = _InflightEntry(future=future, created_at=now)

        try:
            result = await call_fn()
            future.set_result(result)
            return result, False
        except Exception as exc:
            future.set_exception(exc)
            raise
        finally:
            async with self._lock:
                self._inflight.pop(key, None)


_coalescer: GatewayCoalescer | None = None


def get_gateway_coalescer() -> GatewayCoalescer:
    global _coalescer
    if _coalescer is None:
        _coalescer = GatewayCoalescer()
    return _coalescer


def _parse_opt_bool(value: Any, *, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in _TRUTHY:
        return True
    if text in _FALSY:
        return False
    return default


def resolve_optimization_flags(
    headers: Any,
    body: dict[str, Any] | None,
    *,
    extras: dict[str, Any] | None = None,
) -> OptimizationFlags:
    """Resolve per-feature flags. Header/body explicit false opts out."""
    body = dict(body or {})
    if extras:
        for key in (
            BODY_EXACT_CACHE,
            BODY_COALESCE,
            BODY_PROVIDER_CACHE_LAYOUT,
            BODY_RESPONSE_REPAIR,
        ):
            if key in extras and key not in body:
                body[key] = extras[key]

    def _header(name: str) -> str | None:
        if headers is None:
            return None
        getter = getattr(headers, "get", None)
        if callable(getter):
            return getter(name)
        return None

    def _resolve(header: str, body_key: str) -> bool:
        hv = _header(header)
        if hv is not None and str(hv).strip() != "":
            return _parse_opt_bool(hv, default=True)
        if body_key in body:
            return _parse_opt_bool(body.get(body_key), default=True)
        return True

    return OptimizationFlags(
        exact_cache=_resolve(HEADER_EXACT_CACHE, BODY_EXACT_CACHE),
        coalesce=_resolve(HEADER_COALESCE, BODY_COALESCE),
        provider_cache_layout=_resolve(
            HEADER_PROVIDER_CACHE_LAYOUT, BODY_PROVIDER_CACHE_LAYOUT
        ),
        response_repair=_resolve(HEADER_RESPONSE_REPAIR, BODY_RESPONSE_REPAIR),
    )


def _collapse_whitespace(text: str) -> str:
    return " ".join(text.split())


def _normalize_content_part(part: Any) -> Any:
    if isinstance(part, str):
        return _collapse_whitespace(part)
    if not isinstance(part, dict):
        return part
    out = dict(part)
    if isinstance(out.get("text"), str):
        out["text"] = _collapse_whitespace(out["text"])
    return out


def _normalize_message_for_key(msg: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"role": msg.get("role")}
    content = msg.get("content")
    if isinstance(content, str):
        out["content"] = _collapse_whitespace(content)
    elif isinstance(content, list):
        out["content"] = [_normalize_content_part(p) for p in content]
    elif content is not None:
        out["content"] = content
    for key in ("name", "tool_call_id", "tool_calls", "function_call"):
        if key in msg:
            out[key] = msg[key]
    return out


def _stable_json(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    # Outer cache-key dump uses sort_keys=True; no need to round-trip here.
    return value


def cache_key_for_chat(
    *,
    org_id: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: Any = None,
    tool_choice: Any = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    max_completion_tokens: int | None = None,
    seed: int | None = None,
    top_p: float | None = None,
    n: int | None = None,
    stop: Any = None,
    response_format: Any = None,
    functions: Any = None,
    function_call: Any = None,
    presence_penalty: float | None = None,
    frequency_penalty: float | None = None,
) -> str:
    """Deterministic cache key for a chat completion request."""
    normalized = [_normalize_message_for_key(m) for m in messages if isinstance(m, dict)]
    payload = {
        "messages": normalized,
        "model": model,
        "temperature": 0.0 if temperature is None else float(temperature),
        "max_tokens": max_tokens,
        "max_completion_tokens": max_completion_tokens,
        "seed": seed,
        "top_p": top_p,
        "n": n,
        "stop": _stable_json(stop),
        "response_format": _stable_json(response_format),
        "tools": _stable_json(tools),
        "tool_choice": _stable_json(tool_choice),
        "functions": _stable_json(functions),
        "function_call": _stable_json(function_call),
        "presence_penalty": presence_penalty,
        "frequency_penalty": frequency_penalty,
    }
    # sort_keys via stdlib for cross-orjson deterministic digests.
    import json as _json

    canonical = _json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"{_EXACT_CACHE_PREFIX}:{org_id}:{digest}"


def _is_anthropic_provider(provider: str) -> bool:
    p = (provider or "").lower()
    return "anthropic" in p


def _copy_messages_for_layout(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Shallow-copy message dicts (and list content) for safe mutation.

    Cheaper than ``copy.deepcopy`` on large multimodal message trees;
    nested dict parts are copied only when the Anthropic cache path
    mutates list content.
    """
    out: list[dict[str, Any]] = []
    for msg in messages:
        copied = dict(msg)
        content = copied.get("content")
        if isinstance(content, list):
            copied["content"] = [
                dict(part) if isinstance(part, dict) else part for part in content
            ]
        out.append(copied)
    return out


def layout_for_provider_cache(
    messages: list[dict[str, Any]],
    *,
    provider: str = "",
) -> tuple[list[dict[str, Any]], bool]:
    """Reorder messages and attach provider cache hints when safe.

    Returns ``(messages, applied)``.
    """
    if not messages:
        return messages, False

    out = _copy_messages_for_layout(messages)
    applied = False

    # Stable ordering: system messages first (preserve relative order).
    system_msgs = [m for m in out if m.get("role") == "system"]
    other_msgs = [m for m in out if m.get("role") != "system"]
    if system_msgs and (system_msgs != out[: len(system_msgs)]):
        out = system_msgs + other_msgs
        applied = True

    if _is_anthropic_provider(provider) and system_msgs:
        last_static = None
        for i, msg in enumerate(out):
            if msg.get("role") == "system":
                last_static = i
        if last_static is not None:
            msg = out[last_static]
            if isinstance(msg.get("content"), str):
                msg["content"] = [
                    {
                        "type": "text",
                        "text": msg["content"],
                        "cache_control": {"type": "ephemeral"},
                    }
                ]
                applied = True
            elif isinstance(msg.get("content"), list):
                for part in reversed(msg["content"]):
                    if isinstance(part, dict) and part.get("type") == "text":
                        if "cache_control" not in part:
                            part["cache_control"] = {"type": "ephemeral"}
                            applied = True
                        break

    return out, applied


def exact_cache_eligible(temperature: float | None) -> bool:
    """Exact response cache only applies to deterministic requests."""
    if temperature is None:
        return False
    return float(temperature) == 0.0


async def get_exact_cached_response(cache_key: str) -> dict[str, Any] | None:
    client = await get_redis_client()
    if client is None:
        return None
    try:
        raw = await client.get(cache_key)
        if raw is None:
            return None
        data = json_loads(raw)
        if isinstance(data, dict):
            return data
    except Exception as exc:  # noqa: BLE001
        logger.debug("gateway exact cache get failed: %s", exc)
    return None


async def set_exact_cached_response(
    cache_key: str,
    response: dict[str, Any],
    *,
    ttl: int = _EXACT_CACHE_TTL,
) -> None:
    client = await get_redis_client()
    if client is None:
        return
    try:
        await client.set(cache_key, json_dumps(response), ex=ttl)
    except Exception as exc:  # noqa: BLE001
        logger.debug("gateway exact cache set failed: %s", exc)


def optimization_opt_out_headers(
    *,
    exact_cache: bool = True,
    coalesce: bool = True,
    provider_cache_layout: bool = True,
    response_repair: bool = True,
) -> dict[str, str]:
    """Emit headers only for disabled features (quiet default-on path)."""
    headers: dict[str, str] = {}
    if not exact_cache:
        headers[HEADER_EXACT_CACHE] = "false"
    if not coalesce:
        headers[HEADER_COALESCE] = "false"
    if not provider_cache_layout:
        headers[HEADER_PROVIDER_CACHE_LAYOUT] = "false"
    if not response_repair:
        headers[HEADER_RESPONSE_REPAIR] = "false"
    return headers


def optimization_response_headers(tags: list[str]) -> dict[str, str]:
    """Response headers so callers see what the gateway did (no portal required)."""
    headers: dict[str, str] = {}
    tag_set = set(tags)
    if "exact_cache:hit" in tag_set:
        headers[HEADER_EXACT_CACHE] = "hit"
    if "coalesce:hit" in tag_set:
        headers[HEADER_COALESCE] = "hit"
    if "provider_cache_layout:applied" in tag_set:
        headers[HEADER_PROVIDER_CACHE_LAYOUT] = "applied"
    if "response_repair:applied" in tag_set:
        headers[HEADER_RESPONSE_REPAIR] = "applied"
    if tags:
        headers["X-Eden-Optimizations"] = ",".join(tags)
    return headers


def optimization_telemetry_tags(tags: list[str]) -> list[str]:
    """Flatten optimization tags for ``TelemetryEvent.tags``."""
    return [f"optimization:{tag}" for tag in tags]
