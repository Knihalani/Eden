"""F71 — Interactive Slack bot (extends F47/F81).

Handles slash commands and Block Kit interactions for ack, triage,
trace lookup, and issue assignment.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any
from urllib.parse import parse_qs

import httpx

logger = logging.getLogger(__name__)

_HTTPX: httpx.AsyncClient | None = None
_VALUE_SEP = "|"


def _shared_httpx(timeout: float) -> httpx.AsyncClient:
    """Process-wide httpx client — never ``async with`` this instance."""
    global _HTTPX
    if _HTTPX is None or _HTTPX.is_closed:
        _HTTPX = httpx.AsyncClient(timeout=timeout)
    return _HTTPX


def verify_slack_signature(
    *,
    signing_secret: str,
    timestamp: str,
    body: bytes,
    signature: str,
) -> bool:
    if not signing_secret or not signature:
        return False
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - ts) > 60 * 5:
        return False
    base = f"v0:{timestamp}:{body.decode('utf-8')}"
    digest = hmac.new(
        signing_secret.encode("utf-8"),
        base.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    expected = f"v0={digest}"
    return hmac.compare_digest(expected, signature)


def encode_action_value(org_id: str, resource_id: str) -> str:
    """Embed Eden ``org_id`` in Block Kit action values (not Slack team_id)."""
    return f"{org_id}{_VALUE_SEP}{resource_id}"


def decode_action_value(value: str) -> tuple[str | None, str]:
    """Return ``(org_id, resource_id)`` from an encoded action value."""
    raw = str(value or "")
    if _VALUE_SEP in raw:
        org_id, resource_id = raw.split(_VALUE_SEP, 1)
        return (org_id or None), resource_id
    return None, raw


async def resolve_eden_org_for_slack_team(team_id: str) -> str | None:
    """Map Slack ``team_id`` → Eden org via ``org_integrations`` config."""
    if not team_id:
        return None
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return None
        row = await client.fetchrow(
            """
            SELECT org_id FROM org_integrations
            WHERE provider = 'slack'
              AND enabled = true
              AND (
                    config->>'team_id' = $1
                 OR config->>'slack_team_id' = $1
              )
            LIMIT 1
            """,
            team_id,
        )
        return str(row["org_id"]) if row else None
    except Exception as exc:
        logger.debug("slack interactive: team→org lookup failed: %s", exc)
        return None


async def handle_slash_command(payload: dict[str, Any]) -> dict[str, Any]:
    """Route ``/eden`` slash commands."""
    text = str(payload.get("text") or "").strip()
    team_id = str(payload.get("team_id") or payload.get("enterprise_id") or "")
    user = str(payload.get("user_id") or "")
    org_id = await resolve_eden_org_for_slack_team(team_id)

    if not text:
        return _ephemeral(
            "Usage: `/eden trace <trace_id>` | `/eden issue <issue_id>` "
            "| `/eden ack <issue_id>`"
        )

    if not org_id:
        return _ephemeral(
            "This Slack workspace is not linked to an Eden org. "
            "Ask an admin to set `team_id` on the Slack integration."
        )

    parts = text.split(maxsplit=1)
    cmd = parts[0].lower()
    arg = parts[1].strip() if len(parts) > 1 else ""

    if cmd == "trace" and arg:
        return await _trace_lookup(org_id, arg)
    if cmd == "issue" and arg:
        return await _issue_summary(org_id, arg)
    if cmd == "ack" and arg:
        return await _ack_issue(org_id, arg, user_id=user)
    return _ephemeral(f"Unknown command `{cmd}`. Try trace, issue, or ack.")


async def handle_block_actions(payload: dict[str, Any]) -> dict[str, Any]:
    """Handle interactive button clicks from F47 alert blocks."""
    actions = payload.get("actions") or []
    if not actions:
        return {}
    action = actions[0]
    action_id = str(action.get("action_id") or "")
    value = str(action.get("value") or "")
    user = (payload.get("user") or {}).get("id") or ""
    team_id = str(
        (payload.get("team") or {}).get("id")
        or (payload.get("enterprise") or {}).get("id")
        or ""
    )
    org_from_value, resource_id = decode_action_value(value)
    org_id = org_from_value or await resolve_eden_org_for_slack_team(team_id)
    if not org_id:
        return _ephemeral(
            "This Slack workspace is not linked to an Eden org."
        )
    if not resource_id:
        return _ephemeral("Missing resource id.")

    if action_id == "eden_ack_issue":
        return await _ack_issue(org_id, resource_id, user_id=user)
    if action_id == "eden_assign_issue":
        return await _assign_issue(org_id, resource_id, assignee=user)
    if action_id == "eden_view_trace":
        return await _trace_lookup(org_id, resource_id)
    return {}


def parse_interaction_body(body: bytes, content_type: str) -> dict[str, Any]:
    raw = body.decode("utf-8")
    if "application/json" in content_type:
        return json.loads(raw)
    parsed = parse_qs(raw)
    payload = parsed.get("payload", [""])[0]
    return json.loads(payload) if payload else {}


async def _trace_lookup(org_id: str, trace_id: str) -> dict[str, Any]:
    from eden.config import get_settings

    base = str(getattr(get_settings(), "portal_base_url", "") or "").rstrip("/")
    url = f"{base}/traces/{trace_id}?org={org_id}" if base else trace_id
    try:
        from eden.insights.rca._common import _fetch_trace_events

        events = await _fetch_trace_events(org_id, trace_id)
        steps = len(events)
    except Exception:
        steps = 0
    return _ephemeral(
        f"*Trace* `{trace_id[:24]}…`\n"
        f"Steps: {steps}\n"
        f"<{url}|Open in Eden>"
    )


async def _issue_summary(org_id: str, issue_id: str) -> dict[str, Any]:
    from eden.integrations.slack.alerts import _portal_issue_url
    from eden.issues.repo import IssuesRepo

    issue = await IssuesRepo().get_issue(org_id, issue_id)
    if issue is None:
        return _ephemeral(f"Issue `{issue_id}` not found.")
    url = _portal_issue_url(org_id, issue_id)
    return _ephemeral(
        f"*{issue.title}*\n"
        f"Status: `{issue.status}` · Severity: `{issue.severity}`\n"
        f"Stumbles: {issue.stumble_count} · Users: {issue.user_count}\n"
        f"<{url}|Open issue>"
    )


async def _ack_issue(org_id: str, issue_id: str, *, user_id: str) -> dict[str, Any]:
    from eden.issues.repo import IssuesRepo

    repo = IssuesRepo()
    issue = await repo.get_issue(org_id, issue_id)
    if issue is None:
        return _ephemeral(f"Issue `{issue_id}` not found.")
    triage = dict(issue.triage_result or {})
    triage["slack_ack"] = {
        "user_id": user_id,
        "acked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    await repo.set_triage_result(org_id, issue_id, triage)
    if issue.status == "open":
        await repo.set_status(org_id, issue_id, "triaged")
    return _ephemeral(f":white_check_mark: Acknowledged issue `{issue_id[:12]}…`")


async def _assign_issue(
    org_id: str, issue_id: str, *, assignee: str
) -> dict[str, Any]:
    from eden.issues.repo import IssuesRepo

    repo = IssuesRepo()
    issue = await repo.get_issue(org_id, issue_id)
    if issue is None:
        return _ephemeral(f"Issue `{issue_id}` not found.")
    triage = dict(issue.triage_result or {})
    triage["assigned_to"] = assignee
    triage["assigned_via"] = "slack"
    await repo.set_triage_result(org_id, issue_id, triage)
    return _ephemeral(
        f":bust_in_silhouette: Assigned issue `{issue_id[:12]}…` to <@{assignee}>"
    )


def _ephemeral(text: str) -> dict[str, Any]:
    return {
        "response_type": "ephemeral",
        "text": text,
    }


def interactive_action_blocks(
    org_id: str, issue_id: str, trace_id: str | None = None
) -> list[dict[str, Any]]:
    """Optional interactive buttons for outbound F47 alerts."""
    elements: list[dict[str, Any]] = [
        {
            "type": "button",
            "action_id": "eden_ack_issue",
            "text": {"type": "plain_text", "text": "Acknowledge"},
            "value": encode_action_value(org_id, issue_id),
        },
        {
            "type": "button",
            "action_id": "eden_assign_issue",
            "text": {"type": "plain_text", "text": "Assign to me"},
            "value": encode_action_value(org_id, issue_id),
        },
    ]
    if trace_id:
        elements.append(
            {
                "type": "button",
                "action_id": "eden_view_trace",
                "text": {"type": "plain_text", "text": "View trace"},
                "value": encode_action_value(org_id, trace_id),
            }
        )
    return [{"type": "actions", "elements": elements}]


async def post_response_url(response_url: str, body: dict[str, Any]) -> bool:
    if not response_url:
        return False
    try:
        client = _shared_httpx(10.0)
        resp = await client.post(response_url, json=body)
        return resp.status_code in (200, 204)
    except httpx.RequestError as exc:
        logger.debug("slack interactive: response_url failed: %s", exc)
        return False
