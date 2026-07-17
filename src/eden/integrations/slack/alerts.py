"""Slack Block Kit alerts for closed-loop issues (F47, Wave 7).

The orchestrator calls :func:`alert_issue_event` at three moments:

* a **P0/P1 issue is created** (or regressed),
* a **verify fails** (a fix didn't hold), and
* an issue is **escalated to a human**.

Lower-severity issue creation is intentionally *not* paged — the portal
issue list is the surface for those. Two storm caps protect on-call:

* **dedupe** — an identical ``(issue_id, event)`` alert is suppressed for
  ``issue_alert_dedup_minutes`` (Redis ``SET NX EX``), so a re-delivery or
  a flapping verify doesn't double-page; and
* **rate cap** — an org is limited to ``issue_alert_max_per_hour`` alerts
  per rolling hour (Redis counter), after which alerts are dropped with a
  single "storm" log line.

The webhook URL is resolved per-org (``org_integrations`` when present)
with a global ``slack_webhook_url`` fallback; with no webhook configured
the function no-ops (returns ``False``) so nothing breaks in dev.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Events that are allowed to page. Issue creation only pages for P0/P1
# (enforced separately on severity); verify_failed / human_escalation
# always page.
_ALERTABLE = {"issue_created", "verify_failed", "human_escalation"}
_PAGE_SEVERITIES = {"p0", "p1"}

_EMOJI = {
    "issue_created": ":rotating_light:",
    "verify_failed": ":x:",
    "human_escalation": ":raising_hand:",
}


async def alert_issue_event(
    org_id: str,
    *,
    issue_id: str,
    payload: dict[str, Any] | None = None,
    triage_result: dict[str, Any] | None = None,
    human_escalation: bool = False,
) -> bool:
    """Post a Slack alert for a closed-loop issue event.

    Returns True when an alert was actually delivered, False when it was
    skipped (disabled, deduped, storm-capped, below severity, or no
    webhook). Never raises.
    """
    try:
        return await _alert_issue_event_inner(
            org_id,
            issue_id=issue_id,
            payload=payload or {},
            triage_result=triage_result or {},
            human_escalation=human_escalation,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("slack alerts: alert_issue_event failed: %s", exc)
        return False


async def _alert_issue_event_inner(
    org_id: str,
    *,
    issue_id: str,
    payload: dict[str, Any],
    triage_result: dict[str, Any],
    human_escalation: bool,
) -> bool:
    from eden.config import get_settings

    settings = get_settings()
    if not getattr(settings, "issue_alerts_enabled", True):
        return False

    event, severity = _classify(payload, human_escalation)
    if event not in _ALERTABLE:
        return False
    if event == "issue_created" and severity not in _PAGE_SEVERITIES:
        return False

    webhook = await _resolve_webhook(org_id, settings)
    if not webhook:
        logger.debug("slack alerts: no webhook for org=%s; skipping", org_id)
        return False

    redis = await _redis()
    if redis is not None and not await _pass_storm_caps(
        redis, org_id, issue_id, event, settings
    ):
        return False

    blocks = _build_blocks(
        org_id,
        issue_id=issue_id,
        event=event,
        severity=severity,
        payload=payload,
        triage_result=triage_result,
    )
    return await _post(webhook, blocks, event, severity)


def _classify(
    payload: dict[str, Any], human_escalation: bool
) -> tuple[str, str]:
    if human_escalation:
        event = "human_escalation"
    elif payload.get("verify") is not None or payload.get("event") == "verify_failed":
        event = "verify_failed"
    else:
        event = "issue_created"
    severity = str(payload.get("severity") or "p2").lower()
    return event, severity


async def _pass_storm_caps(
    redis: Any,
    org_id: str,
    issue_id: str,
    event: str,
    settings: Any,
) -> bool:
    dedup_min = int(getattr(settings, "issue_alert_dedup_minutes", 15))
    max_hr = int(getattr(settings, "issue_alert_max_per_hour", 30))

    # Dedup: identical (issue, event) within the window → suppress.
    try:
        was_set = await redis.set(
            f"alert:dedup:{org_id}:{issue_id}:{event}",
            "1",
            ex=dedup_min * 60,
            nx=True,
        )
        if not was_set:
            logger.debug("slack alerts: deduped %s/%s", issue_id, event)
            return False
    except Exception:
        pass

    # Rate cap: per-org rolling hour.
    try:
        key = f"alert:rate:{org_id}"
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, 3600)
        if count > max_hr:
            if count == max_hr + 1:
                logger.warning(
                    "slack alerts: org=%s hit storm cap (%s/hr) — suppressing",
                    org_id,
                    max_hr,
                )
            return False
    except Exception:
        pass
    return True


def _portal_issue_url(org_id: str, issue_id: str) -> str:
    from eden.config import get_settings

    base = str(getattr(get_settings(), "portal_base_url", "") or "").rstrip("/")
    if not base:
        base = "https://portal.example.com"
    return f"{base}/issues/{issue_id}?org={org_id}"


def cursor_deep_link(org_id: str, issue_id: str) -> str:
    """Return the documented Cursor deep link for triaging an issue.

    Format (F04): ``cursor://eden.triage/issue?org=<org>&issue=<id>``. Opening
    the link launches Cursor and hands the issue id to the Eden MCP server's
    ``triage_issue`` tool so an engineer can pick up the investigation in-IDE.
    """
    return f"cursor://eden.triage/issue?org={org_id}&issue={issue_id}"


def _build_blocks(
    org_id: str,
    *,
    issue_id: str,
    event: str,
    severity: str,
    payload: dict[str, Any],
    triage_result: dict[str, Any],
) -> list[dict[str, Any]]:
    emoji = _EMOJI.get(event, ":bell:")
    title = payload.get("title") or triage_result.get("summary") or issue_id
    kind = payload.get("kind") or "issue"
    headline = {
        "issue_created": f"{emoji} New {severity.upper()} issue",
        "verify_failed": f"{emoji} Fix verification FAILED",
        "human_escalation": f"{emoji} Issue escalated for human review",
    }.get(event, f"{emoji} Issue update")

    fields = [
        {"type": "mrkdwn", "text": f"*Severity:*\n{severity.upper()}"},
        {"type": "mrkdwn", "text": f"*Kind:*\n{kind}"},
    ]
    # F29/F47 AC: P0 alerts carry the blast-radius (user_count) + volume.
    user_count = payload.get("user_count")
    if user_count is not None:
        fields.append(
            {"type": "mrkdwn", "text": f"*Users affected:*\n{user_count}"}
        )
    stumble_count = payload.get("stumble_count")
    if stumble_count is not None:
        fields.append(
            {"type": "mrkdwn", "text": f"*Stumbles:*\n{stumble_count}"}
        )
    agent_id = payload.get("agent_id")
    if agent_id:
        fields.append({"type": "mrkdwn", "text": f"*Agent:*\n{agent_id}"})
    src = triage_result.get("source")
    if src:
        fields.append({"type": "mrkdwn", "text": f"*Triage:*\n{src}"})
    if payload.get("regressed"):
        fields.append({"type": "mrkdwn", "text": "*Regressed:*\n:warning: yes"})

    context_line = f"org `{org_id}` · issue `{issue_id}`"
    reason = (payload.get("verify") or {}).get("reason") if isinstance(
        payload.get("verify"), dict
    ) else None

    blocks: list[dict[str, Any]] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": headline[:150], "emoji": True},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*{str(title)[:280]}*"},
            "fields": fields[:10],  # Slack caps section fields at 10.
        },
    ]
    if reason:
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"_Reason:_ {str(reason)[:280]}"},
            }
        )
    # Action buttons: portal deep link + Cursor deep link (F04).
    blocks.append(
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {
                        "type": "plain_text",
                        "text": "View Issue",
                        "emoji": True,
                    },
                    "url": _portal_issue_url(org_id, issue_id),
                    "style": "primary",
                },
                {
                    "type": "button",
                    "text": {
                        "type": "plain_text",
                        "text": "Triage in Cursor",
                        "emoji": True,
                    },
                    "url": cursor_deep_link(org_id, issue_id),
                },
            ],
        }
    )
    from eden.config import get_settings

    if getattr(get_settings(), "slack_interactive_v1", True):
        try:
            from eden.integrations.slack.interactive import interactive_action_blocks

            trace_id = payload.get("trace_id") or payload.get("example_trace_id")
            blocks.extend(
                interactive_action_blocks(org_id, issue_id, str(trace_id) if trace_id else None)
            )
        except Exception as exc:
            logger.debug("slack alerts: interactive blocks skipped: %s", exc)
    blocks.append(
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": context_line}],
        }
    )
    return blocks


# Block types Slack Block Kit accepts at the top level of a message.
_VALID_BLOCK_TYPES = {
    "header",
    "section",
    "actions",
    "context",
    "divider",
    "image",
}


def validate_blocks(blocks: list[dict[str, Any]]) -> list[str]:
    """Structural Block Kit validation (CI linter surrogate).

    Returns a list of human-readable errors (empty = valid). Enforces the
    subset of Slack's Block Kit constraints we rely on: ≤50 blocks, known
    block types, header ``plain_text`` ≤150 chars, ≤10 section fields, and
    well-formed action button ``url`` elements.
    """
    errors: list[str] = []
    if not isinstance(blocks, list):
        return ["blocks must be a list"]
    if len(blocks) > 50:
        errors.append(f"too many blocks: {len(blocks)} > 50")
    for i, b in enumerate(blocks):
        if not isinstance(b, dict):
            errors.append(f"block[{i}] is not an object")
            continue
        btype = b.get("type")
        if btype not in _VALID_BLOCK_TYPES:
            errors.append(f"block[{i}] invalid type {btype!r}")
            continue
        if btype == "header":
            txt = (b.get("text") or {})
            if txt.get("type") != "plain_text":
                errors.append(f"block[{i}] header text must be plain_text")
            if len(str(txt.get("text", ""))) > 150:
                errors.append(f"block[{i}] header text >150 chars")
        if btype == "section":
            flds = b.get("fields")
            if flds is not None:
                if not isinstance(flds, list):
                    errors.append(f"block[{i}] section fields must be a list")
                elif len(flds) > 10:
                    errors.append(f"block[{i}] section has >10 fields")
            if "text" not in b and not b.get("fields"):
                errors.append(f"block[{i}] section needs text or fields")
        if btype == "actions":
            elements = b.get("elements") or []
            if not isinstance(elements, list) or not elements:
                errors.append(f"block[{i}] actions needs elements")
            elif len(elements) > 25:
                errors.append(f"block[{i}] actions has >25 elements")
            else:
                for j, el in enumerate(elements):
                    if el.get("type") != "button":
                        continue
                    if "url" in el and not str(el["url"]).strip():
                        errors.append(f"block[{i}].element[{j}] empty url")
                    text = (el.get("text") or {}).get("text")
                    if not text:
                        errors.append(f"block[{i}].element[{j}] missing button text")
    return errors


async def _post(
    webhook: str, blocks: list[dict[str, Any]], event: str, severity: str
) -> bool:
    fallback = f"[{severity.upper()}] {event}"
    body = {"text": fallback, "blocks": blocks}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(webhook, json=body)
        if resp.status_code in (200, 204):
            return True
        logger.warning(
            "slack alerts: webhook returned %s: %s",
            resp.status_code,
            resp.text[:200],
        )
        return False
    except httpx.RequestError as exc:
        logger.warning("slack alerts: post failed: %s", exc)
        return False


async def _resolve_webhook(org_id: str, settings: Any) -> str:
    # Per-org override first (org_integrations), then global fallback.
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is not None:
            row = await client.fetchrow(
                "SELECT config FROM org_integrations "
                "WHERE org_id = $1 AND provider = 'slack' AND enabled = true "
                "LIMIT 1",
                org_id,
            )
            if row:
                cfg = row.get("config") or {}
                if isinstance(cfg, str):
                    import json

                    try:
                        cfg = json.loads(cfg)
                    except (TypeError, ValueError):
                        cfg = {}
                url = (cfg or {}).get("webhook_url")
                if url:
                    return str(url)
    except Exception as exc:
        logger.debug("slack alerts: per-org webhook lookup failed: %s", exc)
    return str(getattr(settings, "slack_webhook_url", "") or "")


async def _redis() -> Any | None:
    try:
        from eden.storage.redis import get_redis_client

        return await get_redis_client()
    except Exception:
        return None


async def alert_nl_event(
    org_id: str,
    *,
    alert_event_id: str,
    rule_name: str,
    verdict: dict[str, Any],
    payload: dict[str, Any] | None = None,
) -> bool:
    """Post a Slack alert for a triaged NL alert event (F81).

  Only ``real_incident`` verdicts page on-call. Returns True when delivered.
    """
    if verdict.get("verdict") != "real_incident":
        return False
    try:
        from eden.config import get_settings

        settings = get_settings()
        if not getattr(settings, "issue_alerts_enabled", True):
            return False
        webhook = await _resolve_webhook(org_id, settings)
        if not webhook:
            return False
        payload = payload or {}
        title = payload.get("title") or rule_name
        reason = verdict.get("reason") or "NL alert fired"
        blocks = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": f":rotating_light: {title}"},
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        f"*Rule:* {rule_name}\n"
                        f"*Verdict:* real_incident\n"
                        f"*Reason:* {reason}\n"
                        f"*Event:* `{alert_event_id}`"
                    ),
                },
            },
        ]
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(webhook, json={"blocks": blocks})
            resp.raise_for_status()
        return True
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("slack alerts: alert_nl_event failed: %s", exc)
        return False
