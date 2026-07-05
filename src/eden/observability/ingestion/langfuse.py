"""Langfuse batch-export decoder.

Maps Langfuse's per-project batch export shape to ``TelemetryEvent``.

Langfuse exports arrive as a list of traces. Each trace carries nested
``observations`` (the LLM / tool / span calls inside) and ``scores``
(evaluation scores attached to observations). We emit one
``TelemetryEvent`` per observation; scores become attributes on the
matching event so they survive the dedup and are queryable from the
portal.

Wire shape (one trace)::

    {
      "id": "trace_abc",
      "name": "my-trace",
      "userId": "user-123",
      "sessionId": "session-xyz",
      "release": "v1.0",
      "tags": ["production"],
      "observations": [
        {
          "id": "obs_1",
          "traceId": "trace_abc",
          "parentObservationId": null,
          "type": "GENERATION",          // or "SPAN", "EVENT", "TOOL"
          "name": "openai-chat",
          "startTime": "2024-01-01T00:00:00.000Z",
          "endTime":   "2024-01-01T00:00:01.000Z",
          "model": "gpt-4o",
          "modelParameters": {"temperature": 0.7},
          "input": "Hello",
          "output": "Hi",
          "usage": {"promptTokens": 10, "completionTokens": 20, "totalTokens": 30},
          "metadata": {...}
        }
      ],
      "scores": [
        {"id": "score_1", "observationId": "obs_1", "name": "quality", "value": 0.95}
      ]
    }

A batch export wraps many traces — both ``{"batch": [...]}`` and a raw
list are accepted.
"""

from __future__ import annotations

import contextlib
import json
import logging
from typing import Any

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import SchemaInvalidError
from eden.observability.ingestion.normalizer import normalize_to_telemetry_event
from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


# Map Langfuse observation types to Eden event_type strings.
_LANGFUSE_TYPE_MAP: dict[str, str] = {
    "GENERATION": "langfuse.generation",
    "SPAN": "langfuse.span",
    "EVENT": "langfuse.event",
    "TOOL": "langfuse.tool",
    "AGENT": "langfuse.agent",
    "RETRIEVER": "langfuse.retriever",
    "EMBEDDING": "langfuse.embedding",
    "CHAIN": "langfuse.chain",
}


class LangfuseDecoder:
    """Langfuse batch-export decoder."""

    source_format = "langfuse"

    def detect(self, body: bytes, content_type: str | None) -> bool:
        try:
            parsed = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return False
        if isinstance(parsed, list):
            return any(
                isinstance(t, dict) and (
                    "observations" in t or "scores" in t
                )
                for t in parsed
            )
        if isinstance(parsed, dict):
            if "batch" in parsed:
                return True
            return "observations" in parsed or "scores" in parsed
        return False

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SchemaInvalidError(
                f"Langfuse body is not valid JSON: {exc}",
                problems=[f"json_decode_error: {exc}"],
            )

        # Accept three wire shapes:
        #   1. {"batch": [trace, ...]}
        #   2. [trace, ...]
        #   3. {"observations": [...], "scores": [...]}  (single trace)
        if isinstance(payload, dict) and "batch" in payload:
            traces = payload["batch"] or []
        elif isinstance(payload, list):
            traces = payload
        elif isinstance(payload, dict):
            traces = [payload]
        else:
            raise SchemaInvalidError(
                "Langfuse body must be a list, {batch: [...]}, or single trace",
                problems=["body_shape"],
            )

        if not traces:
            raise SchemaInvalidError(
                "Langfuse body parsed but contained no traces",
                problems=["empty"],
            )

        # Index scores by observationId so we can attach them to the
        # right observation. Scores not attached to a specific
        # observation fall back to the trace-level scope and are
        # merged into the first observation's attributes.
        events: list[TelemetryEvent] = []
        for trace in traces:
            if not isinstance(trace, dict):
                continue
            str(trace.get("id") or trace.get("traceId") or "")
            scores = trace.get("scores") or []
            trace_scores: list[dict[str, Any]] = []
            obs_scores: dict[str, list[dict[str, Any]]] = {}
            for s in scores:
                if not isinstance(s, dict):
                    continue
                obs_id = s.get("observationId")
                if obs_id:
                    obs_scores.setdefault(str(obs_id), []).append(s)
                else:
                    trace_scores.append(s)

            observations = trace.get("observations") or []
            if not observations:
                # Trace without observations — emit one SYSTEM event
                # carrying the trace-level scores and metadata.
                raw = _trace_to_raw(trace, trace_scores, obs_scores={})
                event = await normalize_to_telemetry_event(
                    raw, attribution.with_source_format(self.source_format)
                )
                events.append(event)
                continue

            # Merge trace-level scores into the first observation so
            # they don't get lost. Per-obs scores still attach to their
            # own observation.
            for i, obs in enumerate(observations):
                if not isinstance(obs, dict):
                    continue
                obs_id = str(obs.get("id") or obs.get("observationId") or "")
                scores_for_obs = list(obs_scores.get(obs_id, []))
                if i == 0 and trace_scores:
                    scores_for_obs = list(trace_scores) + scores_for_obs
                raw = _observation_to_raw(
                    obs, trace, obs_id, scores_for_obs
                )
                event = await normalize_to_telemetry_event(
                    raw, attribution.with_source_format(self.source_format)
                )
                events.append(event)

        if not events:
            raise SchemaInvalidError(
                "Langfuse body parsed but contained no observations",
                problems=["no_observations"],
            )
        return events


def _trace_to_raw(
    trace: dict[str, Any],
    trace_scores: list[dict[str, Any]],
    obs_scores: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    """Synthesize a SYSTEM event for a trace-less case."""
    trace_id = str(trace.get("id") or trace.get("traceId") or "")
    return {
        "event_id": f"trace_{trace_id}",
        "trace_id": trace_id,
        "event_type": "langfuse.trace",
        "name": str(trace.get("name") or trace_id),
        "timestamp": (
            trace.get("createdAt")
            or trace.get("timestamp")
            or trace.get("startTime")
        ),
        "realm": "production",
        "payload": {
            "langfuse": {
                "trace_name": trace.get("name"),
                "user_id": trace.get("userId"),
                "session_id": trace.get("sessionId"),
                "release": trace.get("release"),
                "tags": trace.get("tags", []),
                "metadata": trace.get("metadata"),
            },
        },
        "attributes": _langfuse_trace_attributes(trace, trace_scores),
        "tags": _langfuse_tags(trace),
        "outcome": None,
    }


def _observation_to_raw(
    obs: dict[str, Any],
    trace: dict[str, Any],
    obs_id: str,
    scores: list[dict[str, Any]],
) -> dict[str, Any]:
    """Map one Langfuse observation to the intermediate dict."""
    trace_id = str(
        obs.get("traceId") or trace.get("id") or trace.get("traceId") or ""
    )
    obs_type = str(obs.get("type") or "SPAN").upper()
    event_type = _LANGFUSE_TYPE_MAP.get(obs_type, f"langfuse.{obs_type.lower()}")

    # Timing
    timestamp = obs.get("startTime") or obs.get("createdAt")
    duration_ms = None
    if obs.get("endTime") and obs.get("startTime"):
        try:
            from datetime import datetime
            end = datetime.fromisoformat(
                str(obs["endTime"]).replace("Z", "+00:00")
            )
            start = datetime.fromisoformat(
                str(obs["startTime"]).replace("Z", "+00:00")
            )
            duration_ms = (end - start).total_seconds() * 1000
        except (ValueError, TypeError):
            duration_ms = None

    # Usage → metrics
    usage = dict(obs.get("usage") or {})
    metrics: dict[str, float] = {}
    for src_key, dst_key in (
        ("promptTokens", "input_tokens"),
        ("completionTokens", "output_tokens"),
        ("totalTokens", "total_tokens"),
    ):
        if src_key in usage:
            with contextlib.suppress(TypeError, ValueError):
                metrics[dst_key] = float(usage[src_key])

    # Outcome
    level = str(obs.get("level") or "").upper()
    if level in ("ERROR", "WARNING"):
        outcome = "failure" if level == "ERROR" else None
    else:
        outcome = "success" if obs_type == "GENERATION" else None

    # Payload — keep raw input/output for detectors
    payload: dict[str, Any] = {
        "langfuse": {
            "observation_type": obs_type,
            "name": obs.get("name"),
            "input": obs.get("input"),
            "output": obs.get("output"),
            "model": obs.get("model"),
            "model_parameters": obs.get("modelParameters"),
            "metadata": obs.get("metadata"),
            "user_id": trace.get("userId"),
            "session_id": trace.get("sessionId"),
            "release": trace.get("release"),
            "trace_tags": trace.get("tags", []),
        }
    }

    attributes = _langfuse_obs_attributes(obs, obs_id, scores)
    attributes.update(_langfuse_trace_attributes(trace, []))

    tags = _langfuse_tags(trace)
    tags.append(f"langfuse.type:{obs_type.lower()}")
    if obs.get("model"):
        tags.append(f"model:{obs['model']}")

    return {
        "event_id": obs_id or f"obs_{trace_id}_{obs.get('startTime', '')}",
        "trace_id": trace_id,
        "span_id": obs_id or None,
        "parent_span_id": (
            str(obs.get("parentObservationId"))
            if obs.get("parentObservationId") else None
        ),
        "name": str(obs.get("name") or obs_type.lower()),
        "event_type": event_type,
        "timestamp": timestamp,
        "realm": "production",
        "duration_ms": duration_ms,
        "payload": payload,
        "metrics": metrics,
        "attributes": attributes,
        "tags": tags,
        "outcome": outcome,
        # Phase 7.2 — full capture fields. Langfuse stores input/output
        # verbatim; the transcript view renders them directly. Tool
        # calls and images are extracted from the structured input.
        "request_body": _normalize_langfuse_messages(obs.get("input")),
        "response_body": _normalize_langfuse_output(obs.get("output"), obs_type),
        "reasoning": _extract_langfuse_reasoning(obs.get("output")),
        "tool_calls_full": _extract_langfuse_tool_calls(obs.get("output")),
        "tool_results": _extract_langfuse_tool_results(obs.get("input")),
        "images": _extract_langfuse_images(obs.get("input")),
        "audio": [],
        "logprobs": None,
        "citations": _extract_langfuse_citations(obs),
        "finish_reason": _extract_langfuse_finish_reason(obs),
        "stop_sequence": None,
        "system_fingerprint": None,
        "cache_hit": bool(usage.get("cacheReadInputTokens") if isinstance(usage, dict) else 0),
        "prompt_cache_savings_usd": None,
        "model_version": str(obs.get("model") or "") or None,
        "service_tier": None,
    }


def _normalize_langfuse_messages(value: Any) -> dict[str, Any] | None:
    """Coerce a Langfuse `input` field (string, list, or dict) into a
    request-body dict that the portal can render.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return {"messages": [{"role": "user", "content": value}]}
    if isinstance(value, list):
        return {"messages": value}
    if isinstance(value, dict):
        return value
    return None


def _normalize_langfuse_output(value: Any, obs_type: str) -> dict[str, Any] | None:
    """Coerce a Langfuse `output` field into a response-body dict."""
    if value is None:
        return None
    if isinstance(value, str):
        return {"choices": [{"message": {"role": "assistant", "content": value}}]}
    if isinstance(value, list):
        return {"choices": [{"message": m} for m in value if isinstance(m, dict)]}
    if isinstance(value, dict):
        return value
    return None


def _extract_langfuse_reasoning(output: Any) -> dict[str, Any] | None:
    """Langfuse stores reasoning as content blocks with `type=reasoning`."""
    if not isinstance(output, list):
        return None
    out: dict[str, Any] = {}
    for block in output:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "reasoning":
            out.setdefault("reasoning_blocks", []).append({
                "text": block.get("text") or block.get("reasoning"),
            })
    return out or None


def _extract_langfuse_tool_calls(output: Any) -> list[dict[str, Any]]:
    """Langfuse tool calls live as content blocks with `type=tool_use` or
    `type=function`."""
    if not isinstance(output, list):
        return []
    out: list[dict[str, Any]] = []
    for block in output:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype in ("tool_use", "function"):
            out.append({
                "id": block.get("id"),
                "type": btype,
                "name": block.get("name"),
                "arguments": block.get("input") or block.get("arguments"),
            })
    return out


def _extract_langfuse_tool_results(input_value: Any) -> list[dict[str, Any]]:
    """Tool results live in messages[].content[] as `type=tool_result`."""
    if not isinstance(input_value, list):
        return []
    out: list[dict[str, Any]] = []
    for msg in input_value:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    out.append({
                        "tool_use_id": block.get("tool_use_id"),
                        "content": block.get("content"),
                    })
    return out


def _extract_langfuse_images(input_value: Any) -> list[dict[str, Any]]:
    """Images in Langfuse: messages[].content[] with `type=image` or
    `type=image_url`."""
    if not isinstance(input_value, list):
        return []
    out: list[dict[str, Any]] = []
    for msg in input_value:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
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


def _extract_langfuse_citations(obs: dict[str, Any]) -> list[dict[str, Any]]:
    """Langfuse stores citations in `metadata.citations` or as a
    dedicated `citations` field on the observation."""
    out: list[dict[str, Any]] = []
    md = obs.get("metadata") or {}
    if isinstance(md, dict):
        c = md.get("citations")
        if isinstance(c, list):
            out.extend([x for x in c if isinstance(x, dict)])
    c2 = obs.get("citations")
    if isinstance(c2, list):
        out.extend([x for x in c2 if isinstance(x, dict)])
    return out


def _extract_langfuse_finish_reason(obs: dict[str, Any]) -> str | None:
    """Langfuse puts finish reason in `output.finish_reason` or in
    `metadata.finish_reason`."""
    output = obs.get("output")
    if isinstance(output, dict):
        fr = output.get("finish_reason")
        if fr:
            return str(fr)
    md = obs.get("metadata") or {}
    if isinstance(md, dict):
        fr = md.get("finish_reason")
        if fr:
            return str(fr)
    return None


def _langfuse_trace_attributes(
    trace: dict[str, Any],
    scores: list[dict[str, Any]],
) -> dict[str, str]:
    out: dict[str, str] = {}
    if (uid := trace.get("userId")) is not None:
        out["langfuse.user_id"] = str(uid)
    if (sid := trace.get("sessionId")) is not None:
        out["langfuse.session_id"] = str(sid)
    if (rel := trace.get("release")) is not None:
        out["langfuse.release"] = str(rel)
    for s in scores:
        name = s.get("name")
        if name is not None and "value" in s:
            out[f"score.{name}"] = str(s["value"])
    return out


def _langfuse_obs_attributes(
    obs: dict[str, Any],
    obs_id: str,
    scores: list[dict[str, Any]],
) -> dict[str, str]:
    out: dict[str, str] = {
        "langfuse.observation_id": obs_id,
        "langfuse.observation_type": str(obs.get("type") or "SPAN").lower(),
    }
    if obs.get("model"):
        out["langfuse.model"] = str(obs["model"])
    if (level := obs.get("level")) is not None:
        out["langfuse.level"] = str(level).lower()
    for s in scores:
        name = s.get("name")
        if name is not None and "value" in s:
            out[f"score.{name}"] = str(s["value"])
    return out


def _langfuse_tags(trace: dict[str, Any]) -> list[str]:
    tags: list[str] = ["langfuse"]
    for t in trace.get("tags") or []:
        if isinstance(t, str):
            tags.append(t)
    if (rel := trace.get("release")):
        tags.append(f"release:{rel}")
    return tags
