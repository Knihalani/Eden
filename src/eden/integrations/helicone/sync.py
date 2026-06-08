"""Helicone cost-sync webhook consumer.

Helicone can be configured to POST usage events to a customer
endpoint. We accept those events, dedupe by event id, and store
the cost in our Bronze/Silver data lake so it can be cross-checked
against the LLM client emission and the eventual invoice.

Event shape (Helicone v1):

    {
        "id": "evt_...",
        "request_id": "req_...",
        "model": "openai/gpt-4o",
        "provider": "openai",
        "usage": {"prompt_tokens": 123, "completion_tokens": 456, "total_tokens": 579},
        "cost_usd": 0.0123,
        "latency_ms": 800,
        "user_id": "user_...",
        "properties": {"OrgId": "...", "JobId": "..."},
        "created_at": "2026-..."
    }

We don't try to be a complete mirror — we only persist the fields
that downstream analytics actually use.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HeliconeUsageEvent:
    """A normalised Helicone usage event."""

    event_id: str
    request_id: str
    model: str
    provider: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float
    latency_ms: int | None
    user_id: str | None
    org_id: str | None
    job_id: str | None
    created_at: str | None

    def dedup_key(self) -> str:
        """Stable key for dedupe — Helicone's ``id`` is the primary
        identifier, but we hash to keep the on-disk column bounded."""
        return hashlib.sha256(self.event_id.encode("utf-8")).hexdigest()[:32]


def parse_helicone_event(payload: dict[str, Any]) -> HeliconeUsageEvent | None:
    """Parse a Helicone event payload into a normalised event.

    Returns ``None`` for malformed payloads so the route can return
    a 200 (Helicone retries 4xx/5xx events by default; returning 200
    for malformed payloads is the documented "ack-and-drop" pattern).
    """
    try:
        event_id = str(payload.get("id") or payload.get("request_id") or "")
        if not event_id:
            logger.warning("Helicone event missing id and request_id; dropping")
            return None
        usage = payload.get("usage") or {}
        properties = payload.get("properties") or {}
        return HeliconeUsageEvent(
            event_id=event_id,
            request_id=str(payload.get("request_id") or event_id),
            model=str(payload.get("model") or "unknown"),
            provider=str(payload.get("provider") or "unknown"),
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            total_tokens=int(
                usage.get("total_tokens")
                or (int(usage.get("prompt_tokens") or 0) + int(usage.get("completion_tokens") or 0))
            ),
            cost_usd=float(payload.get("cost_usd") or 0.0),
            latency_ms=int(payload["latency_ms"]) if payload.get("latency_ms") is not None else None,
            user_id=payload.get("user_id"),
            org_id=properties.get("OrgId"),
            job_id=properties.get("JobId"),
            created_at=payload.get("created_at"),
        )
    except (TypeError, ValueError, KeyError) as exc:
        logger.warning("Failed to parse Helicone event: %s", exc)
        return None


__all__ = ["HeliconeUsageEvent", "parse_helicone_event"]
