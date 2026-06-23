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

STUB mode (Gate 4a) — same as before: the notifier returns the
payload that *would* have been sent. No real Slack/Teams POST.
Real webhook delivery ships with Gate 4a.

Backward compatibility: the existing ``notify_pr_opened`` /
``notify_revert`` methods keep their old signatures so any
existing caller compiles unchanged. The new ``route_for_patch``
helper is what ``PatchGenerator`` / the scheduler call.
"""

from __future__ import annotations

import logging
from typing import Any

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
    in the caller doesn't silently drop a notification. The
    routing table above is the source of truth — if you want to
    add a new severity, add a row there and this helper doesn't
    need to change.
    """
    if not severity:
        return "medium"
    sev = severity.lower().strip()
    if sev in _SEVERITY_ROUTES:
        return sev
    # Common synonyms from upstream severity schemas.
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
    "slack": False}``. Missing keys default to enabled (so a
    blank policy enables all channels). ``inbox`` is always
    kept on — it's the human-in-the-loop fallback and cannot
    be disabled from the policy (the human MUST see the
    proposed_patches row regardless of channel prefs).
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
        """Phase 3b: severity-aware PR-opened notification.

        ``severity`` selects the routing set; ``notify_channels``
        and ``email_recipients`` come from the org policy. The
        envelope returns the resolved channel set + the payload
        that *would* have been sent on each channel.
        """
        sev = _normalize_severity(severity)
        channels = _SEVERITY_ROUTES.get(sev, _SEVERITY_ROUTES["medium"])
        channels = _apply_opt_outs(channels, notify_channels=notify_channels)
        # STUB Gate-4a message + per-channel payload stub.
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
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "pr_id": pr_id,
                "notification_id": _new_id("notif"),
                "severity": sev,
                "channels": list(channels),
                "payload": payload,
                "message": (
                    "Stub notification — Gate 4a will POST to the "
                    "resolved channels (inbox is the proposed_patches "
                    "row itself)."
                ),
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
        """Phase 3b: severity-aware revert notification.

        Defaults to ``severity='high'`` because a revert is
        always news — a previously-merged PR was bad enough to
        roll back. Critical-tier orgs can override to
        ``critical`` so Slack is paged.
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
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "pr_id": pr_id,
                "notification_id": _new_id("notif"),
                "severity": sev,
                "channels": list(channels),
                "payload": payload,
                "message": (
                    "Stub revert notification — Gate 4a will POST "
                    "to the resolved channels."
                ),
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
        Returns the resolved channel list + the routing table
        key. The notifier does NOT itself trigger any side-
        effect — it returns the verdict and the caller decides
        what to do with it.
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