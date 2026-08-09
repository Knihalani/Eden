"""FEAT-44 — unified alert routing foundation.

Shared severity, destination, and dispatch primitives that the four
historically disjoint alert systems can route through:

* ``eden.automations.engine`` (score-threshold automations)
* ``eden.realtime.alert_stream`` (Kafka rule engine)
* ``eden.dsl.alerts`` / ``eden.alerts.repo`` (NL / EQL alerts)
* ``eden.closed_loop.playbook_router`` (remediation categories)

Callers build a :class:`UnifiedAlertRouteRequest` with one or more
:class:`AlertDestination` entries and await :func:`dispatch_unified_alert`.
Each destination is delivered independently (best-effort, never raises).
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from eden.realtime.alert_stream import AlertChannel, AlertSeverity

logger = logging.getLogger(__name__)


class UnifiedDestinationKind(StrEnum):
    """Notification destinations the unified router can fan out to."""

    EMAIL = "email"
    SLACK = "slack"
    WEBHOOK = "webhook"
    PAGERDUTY = "pagerduty"
    IN_APP = "in_app"
    WEBSOCKET = "websocket"


@dataclass(frozen=True)
class AlertDestination:
    """A single delivery target with optional per-channel configuration."""

    kind: UnifiedDestinationKind
    webhook_url: str | None = None
    channel_id: str | None = None
    agent_id: str | None = None
    headers: dict[str, str] | None = None
    message_override: str | None = None


@dataclass
class UnifiedAlertRouteRequest:
    """Normalized alert event passed into the unified dispatcher."""

    org_id: str
    title: str
    message: str
    severity: AlertSeverity | str = AlertSeverity.WARNING
    event_kind: str = "alert"
    entity_id: str | None = None
    tenant_id: str | None = None
    issue_id: str | None = None
    alert_id: str | None = None
    rule_id: str | None = None
    destinations: list[AlertDestination] = field(default_factory=list)
    context: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] | None = None
    timestamp: str | None = None
    dedup_key: str | None = None


@dataclass
class DestinationDispatchResult:
    kind: UnifiedDestinationKind
    status: str  # sent | skipped | error
    error: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class UnifiedDispatchResult:
    results: list[DestinationDispatchResult] = field(default_factory=list)

    @property
    def any_sent(self) -> bool:
        return any(r.status == "sent" for r in self.results)

    def by_kind(self, kind: UnifiedDestinationKind) -> DestinationDispatchResult | None:
        for r in self.results:
            if r.kind == kind:
                return r
        return None


def _severity_str(severity: AlertSeverity | str) -> str:
    return severity.value if isinstance(severity, AlertSeverity) else str(severity)


def destination_from_channel(channel: AlertChannel | str) -> AlertDestination:
    """Map a legacy :class:`AlertChannel` value to a unified destination."""
    value = channel.value if isinstance(channel, AlertChannel) else str(channel)
    return AlertDestination(kind=UnifiedDestinationKind(value))


def destinations_from_channels(
    channels: list[AlertChannel] | list[str],
) -> list[AlertDestination]:
    return [destination_from_channel(ch) for ch in channels]


def destinations_from_nl_rule_channels(
    channels: dict[str, Any] | None,
) -> list[AlertDestination]:
    """Translate ``nl_alert_rules.channels`` toggles into unified destinations.

    Backward compatible with :func:`eden.services.alert_email._nl_incident_channel_flags`:
    when no messaging channel is explicitly configured, email is the default.
    """
    channels = channels or {}
    messaging_keys = ("email", "slack", "pagerduty")
    explicitly_configured = any(k in channels for k in messaging_keys)
    out: list[AlertDestination] = []
    if bool(channels.get("email")) if explicitly_configured else True:
        out.append(AlertDestination(kind=UnifiedDestinationKind.EMAIL))
    if bool(channels.get("slack")):
        out.append(AlertDestination(kind=UnifiedDestinationKind.SLACK))
    if bool(channels.get("pagerduty")):
        out.append(AlertDestination(kind=UnifiedDestinationKind.PAGERDUTY))
    if bool(channels.get("in_app")):
        out.append(AlertDestination(kind=UnifiedDestinationKind.IN_APP))
    return out


def route_request_from_generated_alert(alert: Any) -> UnifiedAlertRouteRequest:
    """Adapter for :class:`eden.realtime.alert_stream.GeneratedAlert`."""
    return UnifiedAlertRouteRequest(
        org_id=str(alert.tenant_id or ""),
        tenant_id=str(alert.tenant_id or "") or None,
        severity=alert.severity,
        title=str(alert.title),
        message=str(alert.message),
        event_kind="realtime_alert",
        entity_id=str(alert.entity_id) if alert.entity_id else None,
        issue_id=str(alert.entity_id) if alert.entity_id else None,
        alert_id=str(alert.alert_id),
        rule_id=str(alert.rule_id),
        destinations=destinations_from_channels(list(alert.channels)),
        context=dict(alert.context or {}),
        timestamp=str(alert.timestamp),
        dedup_key=f"{alert.rule_id}:{alert.entity_id}",
        extra={
            "rule_id": alert.rule_id,
            "channels": [c.value for c in alert.channels],
        },
    )


async def dispatch_unified_alert(
    request: UnifiedAlertRouteRequest,
) -> UnifiedDispatchResult:
    """Fan out ``request`` to all configured destinations (best-effort)."""
    if not request.destinations:
        return UnifiedDispatchResult(
            results=[
                DestinationDispatchResult(
                    kind=UnifiedDestinationKind.EMAIL,
                    status="skipped",
                    error="no destinations configured",
                )
            ]
        )

    results: list[DestinationDispatchResult] = []
    for dest in request.destinations:
        try:
            results.append(await _dispatch_one(request, dest))
        except Exception as exc:  # noqa: BLE001 - never crash callers
            logger.warning(
                "unified alert dispatch to %s failed: %s", dest.kind.value, exc
            )
            results.append(
                DestinationDispatchResult(
                    kind=dest.kind,
                    status="error",
                    error=str(exc)[:300],
                )
            )
    return UnifiedDispatchResult(results=results)


async def _dispatch_one(
    request: UnifiedAlertRouteRequest,
    dest: AlertDestination,
) -> DestinationDispatchResult:
    handlers = {
        UnifiedDestinationKind.EMAIL: _dispatch_email,
        UnifiedDestinationKind.SLACK: _dispatch_slack,
        UnifiedDestinationKind.WEBHOOK: _dispatch_webhook,
        UnifiedDestinationKind.PAGERDUTY: _dispatch_pagerduty,
        UnifiedDestinationKind.IN_APP: _dispatch_in_app,
        UnifiedDestinationKind.WEBSOCKET: _dispatch_websocket,
    }
    handler = handlers.get(dest.kind)
    if handler is None:
        return DestinationDispatchResult(
            kind=dest.kind,
            status="error",
            error=f"unsupported destination: {dest.kind.value}",
        )
    return await handler(request, dest)


async def _dispatch_email(
    request: UnifiedAlertRouteRequest,
    dest: AlertDestination,
) -> DestinationDispatchResult:
    from eden.services.alert_email import _org_alert_recipients, send_issue_alert_email

    recipients = await _org_alert_recipients(request.org_id)
    if not recipients:
        return DestinationDispatchResult(
            kind=dest.kind,
            status="skipped",
            error="no alert recipients (org has no owner/admin emails)",
            detail={"recipient_count": 0},
        )

    await send_issue_alert_email(
        org_id=request.org_id,
        event_kind=request.event_kind,
        issue_id=request.issue_id or request.entity_id,
        severity=_severity_str(request.severity),
        title=request.title,
        detail=request.message,
        extra=request.extra,
    )
    return DestinationDispatchResult(
        kind=dest.kind,
        status="sent",
        detail={"recipient_count": len(recipients)},
    )


async def _post_json_webhook(
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
) -> tuple[bool, str | None]:
    """SSRF-guarded JSON POST for customer webhook URLs."""
    try:
        from eden.services.webhook_delivery import _assert_public_ip

        _assert_public_ip(url)
    except ValueError as exc:
        return False, f"webhook url rejected: {exc}"
    except Exception:  # pragma: no cover - import/helper failure
        return False, "webhook url rejected: SSRF guard unavailable"

    try:
        import httpx
    except ImportError as exc:  # pragma: no cover
        return False, str(exc)

    body = json.dumps(payload, default=str).encode("utf-8")
    send_headers = {"Content-Type": "application/json", **(headers or {})}
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(url, content=body, headers=send_headers)
        if 200 <= resp.status_code < 300:
            return True, None
        return False, f"HTTP {resp.status_code}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:300]


async def _dispatch_slack(
    request: UnifiedAlertRouteRequest,
    dest: AlertDestination,
) -> DestinationDispatchResult:
    text = dest.message_override or f"{request.title}: {request.message}"
    webhook_url = (dest.webhook_url or "").strip()
    if webhook_url:
        ok, err = await _post_json_webhook(
            webhook_url, {"text": text}, headers=dest.headers
        )
        if ok:
            return DestinationDispatchResult(
                kind=dest.kind,
                status="sent",
                detail={"channel": "incoming_webhook"},
            )
        return DestinationDispatchResult(
            kind=dest.kind,
            status="error",
            error=err or "slack webhook failed",
        )

    from eden.integrations.slack import store as slack_store
    from eden.integrations.slack.client import SlackClient

    channel_id = dest.channel_id
    if not channel_id:
        channel = await slack_store.get_channel(
            request.org_id, agent_id=dest.agent_id
        )
        channel_id = channel.get("channel_id") if channel else None
    if not channel_id:
        return DestinationDispatchResult(
            kind=dest.kind,
            status="skipped",
            error="no Slack channel configured",
        )
    token = await slack_store.get_bot_token(request.org_id)
    if not token:
        return DestinationDispatchResult(
            kind=dest.kind,
            status="skipped",
            error="Slack is not connected for this org",
        )
    resp = await SlackClient(token).post_message(channel=str(channel_id), text=text)
    return DestinationDispatchResult(
        kind=dest.kind,
        status="sent",
        detail={"channel_id": str(channel_id), "ts": str(resp.get("ts") or "")},
    )


async def _dispatch_webhook(
    request: UnifiedAlertRouteRequest,
    dest: AlertDestination,
) -> DestinationDispatchResult:
    from eden.config import get_settings

    settings = get_settings()
    webhook_url = (dest.webhook_url or getattr(settings, "alert_webhook_url", None) or "").strip()
    if not webhook_url:
        return DestinationDispatchResult(
            kind=dest.kind,
            status="skipped",
            error="no webhook url configured",
        )

    payload = {
        "alert_id": request.alert_id,
        "rule_id": request.rule_id,
        "severity": _severity_str(request.severity),
        "title": request.title,
        "message": request.message,
        "entity_id": request.entity_id,
        "tenant_id": request.tenant_id or request.org_id,
        "timestamp": request.timestamp,
        "context": request.context,
    }
    try:
        import aiohttp

        async with aiohttp.ClientSession() as session:
            await session.post(
                webhook_url,
                json=payload,
                headers=dest.headers,
                timeout=aiohttp.ClientTimeout(total=10),
            )
    except Exception as exc:  # noqa: BLE001
        return DestinationDispatchResult(
            kind=dest.kind,
            status="error",
            error=str(exc)[:300],
        )
    return DestinationDispatchResult(kind=dest.kind, status="sent")


async def _dispatch_pagerduty(
    request: UnifiedAlertRouteRequest,
    dest: AlertDestination,
) -> DestinationDispatchResult:
    from eden.services.pagerduty_delivery import send_pagerduty_event

    org_id = request.org_id or request.tenant_id
    await send_pagerduty_event(
        org_id=str(org_id) if org_id else None,
        summary=request.title[:1024],
        source=request.entity_id or "eden",
        severity=_severity_str(request.severity),
        dedup_key=request.dedup_key or f"{request.rule_id}:{request.entity_id}",
        custom_details={
            "message": request.message,
            "rule_id": request.rule_id,
            "entity_id": request.entity_id,
            **request.context,
        },
    )
    return DestinationDispatchResult(kind=dest.kind, status="sent")


async def _dispatch_in_app(
    request: UnifiedAlertRouteRequest,
    dest: AlertDestination,
) -> DestinationDispatchResult:
    from eden.api.deps import resolve_eden_org_id
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if not client:
        return DestinationDispatchResult(
            kind=dest.kind,
            status="skipped",
            error="postgres unavailable",
        )

    tenant_id = request.tenant_id or request.org_id
    org_id = None
    if tenant_id:
        org_id = await resolve_eden_org_id(tenant_id)
    if not org_id:
        return DestinationDispatchResult(
            kind=dest.kind,
            status="skipped",
            error=f"no org_id for tenant {tenant_id}",
        )

    members = await client.fetch(
        "SELECT user_id FROM org_members WHERE org_id = $1",
        org_id,
    )
    if not members:
        return DestinationDispatchResult(
            kind=dest.kind,
            status="skipped",
            error="no org members",
        )

    alert_id = request.alert_id or str(uuid.uuid4())
    timestamp = request.timestamp or ""
    payload = {
        "is_alert": True,
        "severity": _severity_str(request.severity),
        "entity_id": request.entity_id,
        "rule_id": request.rule_id,
        **request.context,
    }
    for member in members:
        notif_id = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO notifications (id, user_id, org_id, type, title, body, data, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            notif_id,
            str(member["user_id"]),
            org_id,
            f"alert:{_severity_str(request.severity)}",
            request.title,
            request.message,
            json.dumps(payload),
            timestamp,
        )
    return DestinationDispatchResult(
        kind=dest.kind,
        status="sent",
        detail={"member_count": len(members), "alert_id": alert_id},
    )


async def _dispatch_websocket(
    request: UnifiedAlertRouteRequest,
    dest: AlertDestination,
) -> DestinationDispatchResult:
    if not request.entity_id:
        return DestinationDispatchResult(
            kind=dest.kind,
            status="skipped",
            error="entity_id required for websocket dispatch",
        )

    alert_dict = {
        "alert_id": request.alert_id,
        "rule_id": request.rule_id,
        "severity": _severity_str(request.severity),
        "title": request.title,
        "message": request.message,
        "entity_id": request.entity_id,
        "tenant_id": request.tenant_id or request.org_id,
        "channels": [d.kind.value for d in request.destinations],
        "context": request.context,
        "timestamp": request.timestamp,
    }

    from eden.api.routes.websocket import broadcast_to_job_websockets

    await broadcast_to_job_websockets(
        request.entity_id,
        {"type": "alert", "alert": alert_dict},
    )
    return DestinationDispatchResult(kind=dest.kind, status="sent")
