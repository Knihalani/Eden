"""Helicone request-log decoder.

Maps Helicone's per-request log format to ``TelemetryEvent``.

Helicone's on-the-wire shape (POSTed from their gateway or pushed from
their dashboard) is a JSON object with at least::

    {
      "request_id": "...",            # also: Helicone-Request-Id header
      "node_id": "root:child:grand",  # also: Helicone-Node-Id header
      "model": "gpt-4o",
      "usage": {
        "prompt_tokens": 100,
        "completion_tokens": 50,
        "total_tokens": 150
      },
      "request": {...},                # raw provider request
      "response": {...},               # raw provider response
      "response_status": 200,
      "start_time": "2024-01-01T00:00:00Z",
      "end_time":   "2024-01-01T00:00:01Z",
      "latency_ms": 1000,
      "cost": 0.003,
      "properties": {"key": "value"},
      "user_id": "user-123",
      "status": "success" | "error" | "timeout" | "cancelled"
    }

The ``node_id`` encodes the parent:child relationship (e.g. ``"root"``
for a root request, ``"root:child_a"`` for a child). The last segment
becomes the ``span_id``; the prefix (everything before the last ``:``)
becomes the ``parent_span_id``.

A ``Helicone-Session-Id`` header (or ``properties.session_id``) groups
related requests into a session — we use it as the ``trace_id`` so
related calls land under the same trace in the portal.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import SchemaInvalidError
from eden.observability.ingestion.normalizer import normalize_to_telemetry_event
from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


def _split_node_id(node_id: str) -> tuple[Optional[str], str]:
    """Helicone's ``Helicone-Node-Id`` is ``"parent:child"``. Returns
    ``(parent_span_id, span_id)``. For a root request (``"abc"``) the
    parent is ``None`` and the span is ``"abc"``.
    """
    if not node_id:
        return None, ""
    parts = node_id.split(":")
    if len(parts) == 1:
        return None, parts[0]
    return ":".join(parts[:-1]), parts[-1]


class HeliconeDecoder:
    """Helicone request-log decoder."""

    source_format = "helicone"

    def detect(self, body: bytes, content_type: Optional[str]) -> bool:
        try:
            parsed = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(parsed, dict):
            return False
        # Helicone has at least one of these distinctive fields.
        keys = {
            "request_id", "requestId", "node_id", "nodeId",
            "response_status", "responseStatus", "helicone_request_id",
        }
        return any(k in parsed for k in keys)

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SchemaInvalidError(
                f"Helicone body is not valid JSON: {exc}",
                problems=[f"json_decode_error: {exc}"],
            )

        # Helicone sends a single request log at a time, but accept a
        # list for symmetry with other decoders.
        if isinstance(payload, list):
            items = [p for p in payload if isinstance(p, dict)]
        elif isinstance(payload, dict):
            items = [payload]
        else:
            raise SchemaInvalidError(
                "Helicone body must be a JSON object or list",
                problems=["body_shape"],
            )

        if not items:
            raise SchemaInvalidError(
                "Helicone body parsed but contained no request logs",
                problems=["empty"],
            )

        events: list[TelemetryEvent] = []
        for item in items:
            raw = _helicone_log_to_raw(item)
            event = await normalize_to_telemetry_event(
                raw, attribution.with_source_format(self.source_format)
            )
            events.append(event)
        return events


def _helicone_log_to_raw(item: dict[str, Any]) -> dict[str, Any]:
    """Map one Helicone request log dict to the intermediate dict."""
    request_id = str(
        item.get("request_id") or item.get("requestId") or item.get("id") or ""
    )
    node_id = str(item.get("node_id") or item.get("nodeId") or "")
    parent_span_id, span_id = _split_node_id(node_id)

    # Session / trace grouping — Helicone-Session-Id header equivalent
    # lives in properties.session_id or properties.sessionId.
    properties = dict(item.get("properties") or {})
    trace_id = str(
        item.get("session_id")
        or item.get("sessionId")
        or properties.get("session_id")
        or properties.get("sessionId")
        or request_id
    )

    # Timing
    timestamp = (
        item.get("start_time")
        or item.get("startTime")
        or item.get("timestamp")
    )
    duration_ms = item.get("latency_ms") or item.get("latencyMs")
    if duration_ms is None and item.get("end_time") and item.get("start_time"):
        try:
            from datetime import datetime
            end = datetime.fromisoformat(
                str(item["end_time"]).replace("Z", "+00:00")
            )
            start = datetime.fromisoformat(
                str(item["start_time"]).replace("Z", "+00:00")
            )
            duration_ms = (end - start).total_seconds() * 1000
        except (ValueError, TypeError):
            duration_ms = None

    # Usage → metrics
    usage = dict(item.get("usage") or {})
    metrics: dict[str, float] = {}
    for src_key, dst_key in (
        ("prompt_tokens", "input_tokens"),
        ("completion_tokens", "output_tokens"),
        ("total_tokens", "total_tokens"),
    ):
        if src_key in usage:
            try:
                metrics[dst_key] = float(usage[src_key])
            except (TypeError, ValueError):
                pass
    cost = item.get("cost")
    if cost is not None:
        try:
            metrics["cost_usd"] = float(cost)
        except (TypeError, ValueError):
            pass

    # Outcome
    response_status = item.get("response_status") or item.get("responseStatus")
    status_str = str(item.get("status") or "").lower()
    if status_str == "error" or (
        isinstance(response_status, int) and response_status >= 400
    ):
        outcome = "failure"
    elif status_str in ("timeout", "timed_out"):
        outcome = "timeout"
    elif status_str == "cancelled":
        outcome = "failure"
    elif status_str in ("success", "completed", ""):
        outcome = "success"
    else:
        outcome = None

    # Payload: the raw request/response go in so detectors can read
    # them later (e.g. hallucination detection needs the prompt).
    payload: dict[str, Any] = {
        "helicone": {
            "request": item.get("request"),
            "response": item.get("response"),
            "response_status": response_status,
            "model": item.get("model"),
            "user_id": item.get("user_id") or item.get("userId"),
            "properties": properties,
        }
    }

    # Attributes — flat key/value for filtering.
    attributes: dict[str, str] = {
        "helicone.request_id": request_id,
        "helicone.node_id": node_id,
    }
    if response_status is not None:
        attributes["helicone.response_status"] = str(response_status)
    if model := item.get("model"):
        attributes["helicone.model"] = str(model)
    if user_id := (item.get("user_id") or item.get("userId")):
        attributes["helicone.user_id"] = str(user_id)

    tags: list[str] = ["helicone"]
    for k, v in properties.items():
        if isinstance(v, (str, int, float, bool)):
            tags.append(f"prop.{k}={v}")

    return {
        "event_id": request_id or f"helicone_{span_id}",
        "trace_id": trace_id,
        "span_id": span_id or None,
        "parent_span_id": parent_span_id,
        "name": str(item.get("model") or ""),
        "event_type": "helicone.llm_call",
        "timestamp": timestamp,
        "realm": "production",
        "duration_ms": duration_ms,
        "payload": payload,
        "metrics": metrics,
        "attributes": attributes,
        "tags": tags,
        "outcome": outcome,
        # Phase 7.2 — full capture fields. Helicone already gives us the
        # raw provider request and response; we plumb them through the
        # dedicated capture columns so the transcript view can render
        # them without re-parsing the legacy `payload.helicone` shape.
        "request_body": item.get("request") if isinstance(item.get("request"), dict) else None,
        "response_body": item.get("response") if isinstance(item.get("response"), dict) else None,
        "reasoning": _extract_helicone_reasoning(item.get("response")),
        "tool_calls_full": _extract_helicone_tool_calls(item.get("response")),
        "tool_results": _extract_helicone_tool_results(item.get("request")),
        "images": _extract_helicone_images(item.get("request")),
        "audio": [],
        "logprobs": _extract_helicone_logprobs(item.get("response")),
        "citations": _extract_helicone_citations(item.get("response")),
        "finish_reason": _extract_helicone_finish_reason(item.get("response")),
        "stop_sequence": None,
        "system_fingerprint": _nested_get(item.get("response"), "system_fingerprint"),
        "cache_hit": bool(item.get("cacheReference") or item.get("cache_reference")),
        "prompt_cache_savings_usd": None,
        "model_version": str(item.get("model") or "") or None,
        "service_tier": _nested_get(item.get("response"), "service_tier"),
    }


def _nested_get(obj: Any, *path: str) -> Any:
    """Safe nested dict access — returns None if any key is missing."""
    for key in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(key)
        if obj is None:
            return None
    return obj


def _extract_helicone_reasoning(response: Any) -> Optional[dict[str, Any]]:
    """Pull OpenAI o1 reasoning tokens out of the response (Helicone
    mirrors the provider response unchanged)."""
    if not isinstance(response, dict):
        return None
    out: dict[str, Any] = {}
    # OpenAI reasoning_tokens
    usage = response.get("usage") or {}
    if isinstance(usage, dict):
        details = usage.get("completion_tokens_details") or {}
        if isinstance(details, dict) and details.get("reasoning_tokens") is not None:
            out["o1_tokens"] = details["reasoning_tokens"]
    # Anthropic thinking
    content = response.get("content")
    if isinstance(content, list):
        thinking = [b for b in content if isinstance(b, dict) and b.get("type") == "thinking"]
        if thinking:
            out["thinking"] = thinking
    return out or None


def _extract_helicone_tool_calls(response: Any) -> list[dict[str, Any]]:
    if not isinstance(response, dict):
        return []
    out: list[dict[str, Any]] = []
    for choice in response.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        msg = choice.get("message") or {}
        for tc in (msg.get("tool_calls") or []):
            if isinstance(tc, dict):
                out.append({
                    "id": tc.get("id"),
                    "type": tc.get("type", "function"),
                    "function": {
                        "name": (tc.get("function") or {}).get("name"),
                        "arguments": (tc.get("function") or {}).get("arguments"),
                    },
                })
    # Anthropic tool_use
    if isinstance(response.get("content"), list):
        for block in response["content"]:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                out.append({
                    "id": block.get("id"),
                    "type": "tool_use",
                    "name": block.get("name"),
                    "input": block.get("input"),
                })
    return out


def _extract_helicone_tool_results(request: Any) -> list[dict[str, Any]]:
    """Tool results live in the request's messages[] (the assistant's
    prior turn), not the response."""
    if not isinstance(request, dict):
        return []
    out: list[dict[str, Any]] = []
    for msg in request.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    out.append({
                        "tool_use_id": block.get("tool_use_id"),
                        "content": block.get("content"),
                        "is_error": block.get("is_error", False),
                    })
    return out


def _extract_helicone_images(request: Any) -> list[dict[str, Any]]:
    """Images live in messages[].content[] for OpenAI, in messages[] for
    Anthropic."""
    if not isinstance(request, dict):
        return []
    out: list[dict[str, Any]] = []
    for msg in request.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "image_url":
                        url_obj = block.get("image_url") or {}
                        out.append({
                            "role": msg.get("role"),
                            "type": "image_url",
                            "url": url_obj.get("url") if isinstance(url_obj, dict) else None,
                            "source": "openai_input",
                        })
                    elif block.get("type") == "image":
                        src = block.get("source") or {}
                        out.append({
                            "role": msg.get("role"),
                            "content_type": src.get("media_type"),
                            "data_b64": src.get("data"),
                            "source": "anthropic_input",
                        })
    return out


def _extract_helicone_logprobs(response: Any) -> Optional[dict[str, Any]]:
    if not isinstance(response, dict):
        return None
    choices = response.get("choices") or []
    if choices and isinstance(choices[0], dict):
        lp = choices[0].get("logprobs")
        if isinstance(lp, dict):
            return lp
    return None


def _extract_helicone_citations(response: Any) -> list[dict[str, Any]]:
    """OpenAI o-series annotations or Anthropic citation blocks."""
    if not isinstance(response, dict):
        return []
    out: list[dict[str, Any]] = []
    # OpenAI
    for choice in response.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        msg = choice.get("message") or {}
        for c in (msg.get("citations") or []):
            if isinstance(c, dict):
                out.append(c)
        for ann in (msg.get("annotations") or []):
            if isinstance(ann, dict) and ann.get("type") == "url_citation":
                out.append({
                    "url": ann.get("url"),
                    "title": ann.get("title"),
                    "start_index": ann.get("start_index"),
                    "end_index": ann.get("end_index"),
                })
    return out


def _extract_helicone_finish_reason(response: Any) -> Optional[str]:
    if not isinstance(response, dict):
        return None
    # OpenAI
    choices = response.get("choices") or []
    if choices and isinstance(choices[0], dict):
        fr = choices[0].get("finish_reason")
        if fr:
            return str(fr)
    # Anthropic
    fr = response.get("stop_reason")
    if fr:
        return str(fr)
    return None
