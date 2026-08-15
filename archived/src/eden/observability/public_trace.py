"""Redacted public trace loader for share links."""

from __future__ import annotations

from typing import Any

from eden.observability.ingestion.pii import mask_attributes, mask_payload


def _flatten_spans(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Depth-first flatten of a trace tree."""
    flat: list[dict[str, Any]] = []
    for node in nodes:
        flat.append(node)
        flat.extend(_flatten_spans(node.get("children") or []))
    return flat


def _strip_media(span: dict[str, Any]) -> None:
    """Remove heavy media blobs from a public span view."""
    span.pop("images", None)
    span.pop("audio", None)


async def load_redacted_public_trace(
    org_id: str,
    trace_id: str,
) -> dict[str, Any] | None:
    """Load a trace tree, flatten, mask PII, and strip media."""
    from eden.observability.telemetry_collector import get_telemetry_collector

    collector = await get_telemetry_collector()
    tree = await collector.get_trace_tree(org_id, trace_id)
    if tree is None:
        return None

    spans: list[dict[str, Any]] = []
    message_count = 0
    for node in _flatten_spans(tree.root_spans):
        span = {k: v for k, v in node.items() if k != "children"}
        _strip_media(span)
        if span.get("payload") is not None:
            span["payload"] = await mask_payload(span["payload"], tenant_id=org_id)
        if span.get("attributes"):
            span["attributes"] = await mask_attributes(
                span.get("attributes") or {},
                tenant_id=org_id,
            )
        for key in ("request_body", "response_body", "reasoning"):
            if span.get(key) is not None:
                span[key] = await mask_payload(span[key], tenant_id=org_id)
        if span.get("request_body") or span.get("response_body"):
            message_count += 1
        spans.append(span)

    return {
        "trace_id": tree.trace_id,
        "org_id": org_id,
        "spans": spans,
        "message_count": message_count,
        "span_count": tree.span_count,
        "duration_ms": tree.total_duration_ms,
        "outcome": tree.outcome,
    }
