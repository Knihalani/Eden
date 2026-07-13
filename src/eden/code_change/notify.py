"""PRReviewerNotifier — route patch notifications by severity.

Phase 3b (2026-06-23) redesign:

* Notifications are now routed by **severity** (low / medium /
  high / critical) instead of all patches using the same template.
* The router table lives in :data:`_SEVERITY_ROUTES` — each
  severity maps to a set of channels (``inbox``, ``digest``,
  ``email``, ``slack``).
* Per-org opt-out is read from the org policy (the new
  ``notify_channels`` field) so an org can turn off email/Slack
  while keeping inbox + digest.

Routing table (per the Phase 3b plan):

* **low** — inbox only. The patch is in proposed_patches with
  ``status='proposed'`` but the reviewer only sees it when they
  open the inbox.
* **medium** — inbox + weekly digest. The patch is included in
  the Monday 09:00 UTC digest that ``weekly_digest`` emits.
* **high** — inbox + digest + email. The PRReviewerNotifier
  fires a SendGrid email to the configured recipient list.
* **critical** — inbox + digest + email + Slack. The notifier
  posts to the configured Slack webhook URL.

Gate 4a: ``notify_pr_opened`` and ``notify_revert`` now POST to the
real Slack webhook (via httpx) when configured, and send email via
the existing ``EmailService`` (SendGrid) when configured. Both
deliveries are fire-and-forget (errors logged, never raised).
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


# Severity → channel routing. Channels are processed in order;
# the ``inbox`` channel is always implied (a proposed_patches row
# with status=proposed is itself the inbox item).
_SEVERITY_ROUTES: dict[str, tuple[str, ...]] = {
    "low": ("inbox",),
    "medium": ("inbox", "digest"),
    "high": ("inbox", "digest", "email"),
    "critical": ("inbox", "digest", "email", "slack"),
}


def _normalize_severity(severity: str | None) -> str:
    """Coerce an arbitrary severity string to the routing table key.

    Unknown / blank values fall back to ``"medium"`` so a typo
    in the caller doesn't silently drop a notification.
    """
    if not severity:
        return "medium"
    sev = severity.lower().strip()
    if sev in _SEVERITY_ROUTES:
        return sev
    aliases = {
        "warn": "low",
        "warning": "low",
        "info": "low",
        "minor": "low",
        "major": "high",
        "error": "high",
        "fatal": "critical",
        "blocker": "critical",
    }
    return aliases.get(sev, "medium")


def _apply_opt_outs(
    channels: tuple[str, ...],
    *,
    notify_channels: dict[str, bool] | None,
) -> tuple[str, ...]:
    """Apply per-org channel opt-outs.

    ``notify_channels`` is a dict like ``{"email": True,
    "slack": False}``. Missing keys default to enabled. ``inbox``
    is always kept on — it is the human-in-the-loop fallback and
    cannot be disabled from the policy.
    """
    if not notify_channels:
        return channels
    out: list[str] = []
    for ch in channels:
        if ch == "inbox":
            out.append(ch)
            continue
        if notify_channels.get(ch, True):
            out.append(ch)
    return tuple(out)


async def _post_slack(webhook_url: str, text: str, blocks: list[dict[str, Any]]) -> bool:
    """POST a Slack Block Kit message to ``webhook_url``.

    Returns ``True`` on a 2xx response; logs and returns ``False`` on any
    error so delivery failures never propagate to callers.
    """
    if not webhook_url:
        return False
    body: dict[str, Any] = {"text": text, "blocks": blocks}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(webhook_url, json=body)
        if resp.status_code in (200, 204):
            return True
        logger.warning(
            "notify: Slack POST returned %s for webhook %s: %s",
            resp.status_code,
            webhook_url[:40],
            resp.text[:200],
        )
        return False
    except httpx.RequestError as exc:
        logger.warning("notify: Slack POST failed: %s", exc)
        return False


async def _send_email_notification(
    recipients: list[str],
    subject: str,
    html_content: str,
) -> bool:
    """Send email via the configured SendGrid integration.

    No-ops (returns ``False``) when ``sendgrid_api_key`` is not set.
    Errors are logged and swallowed.
    """
    if not recipients:
        return False
    try:
        from eden.services.email_service import EmailService
        svc = EmailService()
        if not svc.settings.sendgrid_api_key:
            return False
        results = []
        for addr in recipients:
            result = await svc.send_email(
                to_email=addr,
                subject=subject,
                html_content=html_content,
            )
            results.append(result.status == "sent")
        return any(results)
    except Exception as exc:
        logger.warning("notify: email send failed: %s", exc)
        return False


def _build_pr_slack_blocks(
    org_id: str,
    pr_id: str,
    severity: str,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    emoji = {"low": ":memo:", "medium": ":bell:", "high": ":warning:", "critical": ":rotating_light:"}.get(severity, ":bell:")
    rca = payload.get("rca_category", "unknown")
    test_rate = payload.get("test_pass_rate", 0.0)
    blast = payload.get("blast_radius_score", 0.0)
    buttons = payload.get("buttons", [])
    return [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"{emoji} PR Review Required [{severity.upper()}]", "emoji": True},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*PR:*\n`{pr_id}`"},
                {"type": "mrkdwn", "text": f"*RCA Category:*\n{rca}"},
                {"type": "mrkdwn", "text": f"*Test Pass Rate:*\n{test_rate:.0%}"},
                {"type": "mrkdwn", "text": f"*Blast Radius:*\n{blast:.2f}"},
            ],
        },
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"org `{org_id}` · pr `{pr_id}`"}],
        },
    ]


def _build_revert_slack_blocks(
    org_id: str,
    pr_id: str,
    severity: str,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    emoji = ":rewind:"
    reason = payload.get("revert_reason", "")
    return [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"{emoji} PR Revert Triggered [{severity.upper()}]", "emoji": True},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Reason:* {str(reason)[:300]}"},
        },
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"org `{org_id}` · pr `{pr_id}`"}],
        },
    ]


class PRReviewerNotifier:
    """Post the PR link to Slack/Teams + email + digest + inbox."""

    name = "pr_reviewer_notifier"

    async def notify_pr_opened(
        self,
        org_id: str,
        pr_id: str,
        rca_category: str,
        test_pass_rate: float,
        blast_radius_score: float,
        estimated_cost_savings_usd: float,
        slack_webhook_url: str = "",
        severity: str = "medium",
        notify_channels: dict[str, bool] | None = None,
        email_recipients: list[str] | None = None,
    ) -> dict[str, Any]:
        """Severity-aware PR-opened notification.

        When ``send_slack`` resolves True and a webhook URL is present,
        POSTs a Block Kit message to Slack. When ``send_email`` resolves
        True and SendGrid is configured, sends email to recipients.
        """
        sev = _normalize_severity(severity)
        channels = _SEVERITY_ROUTES.get(sev, _SEVERITY_ROUTES["medium"])
        channels = _apply_opt_outs(channels, notify_channels=notify_channels)

        payload = {
            "rca_category": rca_category,
            "test_pass_rate": test_pass_rate,
            "blast_radius_score": blast_radius_score,
            "estimated_cost_savings_usd": estimated_cost_savings_usd,
            "slack_webhook_url": slack_webhook_url,
            "email_recipients": list(email_recipients or []),
            "buttons": [
                {"label": "View PR", "url": f"https://example.com/pr/{pr_id}"},
                {
                    "label": "Pause auto-revert for 24h",
                    "url": f"https://example.com/pr/{pr_id}/pause",
                },
            ],
        }

        slack_sent = False
        email_sent = False

        if "slack" in channels:
            # Prefer the per-call webhook; fall back to the global config.
            webhook = slack_webhook_url or await _resolve_org_slack_webhook(org_id)
            if webhook:
                blocks = _build_pr_slack_blocks(org_id, pr_id, sev, payload)
                slack_sent = await _post_slack(
                    webhook,
                    text=f"[{sev.upper()}] PR review required: {pr_id}",
                    blocks=blocks,
                )
            else:
                logger.debug(
                    "notify: no Slack webhook configured for org=%s; skipping", org_id
                )

        if "email" in channels and email_recipients:
            subject = f"[Eden] PR Review Required [{sev.upper()}] — {pr_id}"
            html_content = (
                f"<p>A new PR requires review: <strong>{pr_id}</strong></p>"
                f"<p>RCA category: {rca_category} | "
                f"Test pass rate: {test_pass_rate:.0%} | "
                f"Blast radius: {blast_radius_score:.2f}</p>"
            )
            email_sent = await _send_email_notification(email_recipients, subject, html_content)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "pr_id": pr_id,
                "notification_id": _new_id("notif"),
                "severity": sev,
                "channels": list(channels),
                "slack_sent": slack_sent,
                "email_sent": email_sent,
                "payload": payload,
            },
        )

    async def notify_revert(
        self,
        org_id: str,
        pr_id: str,
        revert_reason: str,
        regression_evidence: dict[str, Any] | None = None,
        slack_webhook_url: str = "",
        severity: str = "high",
        notify_channels: dict[str, bool] | None = None,
        email_recipients: list[str] | None = None,
    ) -> dict[str, Any]:
        """Severity-aware revert notification.

        Defaults to ``severity='high'`` because a revert is always news.
        """
        sev = _normalize_severity(severity)
        channels = _SEVERITY_ROUTES.get(sev, _SEVERITY_ROUTES["high"])
        channels = _apply_opt_outs(channels, notify_channels=notify_channels)

        payload = {
            "revert_reason": revert_reason,
            "regression_evidence": regression_evidence or {},
            "slack_webhook_url": slack_webhook_url,
            "email_recipients": list(email_recipients or []),
            "buttons": [
                {
                    "label": "Investigate",
                    "url": (
                        f"https://example.com/rca/{org_id}?pr_id={pr_id}"
                    ),
                },
            ],
        }

        slack_sent = False
        email_sent = False

        if "slack" in channels:
            webhook = slack_webhook_url or await _resolve_org_slack_webhook(org_id)
            if webhook:
                blocks = _build_revert_slack_blocks(org_id, pr_id, sev, payload)
                slack_sent = await _post_slack(
                    webhook,
                    text=f"[{sev.upper()}] PR revert triggered: {pr_id}",
                    blocks=blocks,
                )
            else:
                logger.debug(
                    "notify: no Slack webhook configured for org=%s; skipping", org_id
                )

        if "email" in channels and email_recipients:
            subject = f"[Eden] PR Revert Triggered [{sev.upper()}] — {pr_id}"
            html_content = (
                f"<p>PR <strong>{pr_id}</strong> has been reverted.</p>"
                f"<p>Reason: {revert_reason}</p>"
            )
            email_sent = await _send_email_notification(email_recipients, subject, html_content)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "pr_id": pr_id,
                "notification_id": _new_id("notif"),
                "severity": sev,
                "channels": list(channels),
                "slack_sent": slack_sent,
                "email_sent": email_sent,
                "payload": payload,
            },
        )

    async def route_for_patch(
        self,
        org_id: str,
        patch_id: str,
        severity: str,
        *,
        notify_channels: dict[str, bool] | None = None,
    ) -> dict[str, Any]:
        """Pure helper: return the routing verdict for a patch.

        Used by :class:`eden.code_change.scheduler` to decide
        whether to enqueue the notification job for this patch.
        Returns the resolved channel list without triggering any
        side-effect.
        """
        sev = _normalize_severity(severity)
        channels = _SEVERITY_ROUTES.get(sev, _SEVERITY_ROUTES["medium"])
        channels = _apply_opt_outs(channels, notify_channels=notify_channels)
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "patch_id": patch_id,
                "severity": sev,
                "channels": list(channels),
                "send_email": "email" in channels,
                "send_slack": "slack" in channels,
                "in_digest": "digest" in channels,
            },
        )


async def _resolve_org_slack_webhook(org_id: str) -> str:
    """Look up the org's Slack webhook from ``org_integrations`` or settings."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is not None:
            async with client.acquire() as conn:
                row = await conn.fetchrow(
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
        logger.debug("notify: per-org Slack webhook lookup failed: %s", exc)
    try:
        from eden.config import get_settings
        return str(getattr(get_settings(), "slack_webhook_url", "") or "")
    except Exception:
        return ""
