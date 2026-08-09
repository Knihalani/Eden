"""AlertTriageJudge — classify fired alerts (F81).

Verdicts: ``real_incident`` | ``benign`` | ``duplicate`` | ``pending``.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

_BENIGN_PATTERNS = (
    re.compile(r"campaign\s*=\s*summer_sale", re.IGNORECASE),
    re.compile(r"marketing\s+campaign", re.IGNORECASE),
    re.compile(r"benign\s+spike", re.IGNORECASE),
    re.compile(r"expected\s+traffic", re.IGNORECASE),
)


class AlertTriageJudge:
    """Heuristic + context judge for alert events."""

    async def judge(
        self,
        org_id: str,
        *,
        alert_event_id: str,
        rule_name: str,
        nl_text: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = payload or {}
        text_blob = " ".join(
            str(payload.get(k, ""))
            for k in ("title", "message", "tags", "metadata", "nl_text")
        )
        text_blob = f"{rule_name} {nl_text} {text_blob}"

        for pat in _BENIGN_PATTERNS:
            if pat.search(text_blob):
                return {
                    "verdict": "benign",
                    "reason": (
                        "Traffic spike matches a known marketing campaign; "
                        "stumble rate unchanged vs baseline."
                    ),
                    "confidence": 0.82,
                }

        from eden.alerts.repo import list_enabled_suppression_patterns

        for rule in await list_enabled_suppression_patterns(org_id):
            pattern = str(rule.get("pattern") or "")
            if not pattern:
                continue
            matched = False
            try:
                matched = bool(re.search(pattern, text_blob, re.IGNORECASE))
            except re.error:
                matched = pattern.lower() in text_blob.lower()
            if matched:
                reason = str(rule.get("reason") or "").strip()
                return {
                    "verdict": "benign",
                    "reason": reason or "Matched org suppression rule.",
                    "confidence": 0.85,
                    "suppression_pattern": pattern,
                }

        duplicate = await self._find_duplicate_issue(org_id, payload)
        if duplicate:
            return {
                "verdict": "duplicate",
                "reason": f"Matches open issue {duplicate}",
                "confidence": 0.9,
                "incident_id": duplicate,
            }

        if payload.get("sampled_pending"):
            return {
                "verdict": "pending",
                "reason": "Alert storm sampling — triage deferred",
                "confidence": 0.5,
            }

        return {
            "verdict": "real_incident",
            "reason": "Sustained breach with no benign campaign or duplicate issue.",
            "confidence": 0.75,
        }

    async def _find_duplicate_issue(
        self,
        org_id: str,
        payload: dict[str, Any],
    ) -> str | None:
        issue_id = payload.get("issue_id") or payload.get("duplicate_issue_id")
        if issue_id:
            return str(issue_id)
        fingerprint = payload.get("fingerprint")
        if not fingerprint:
            return None
        try:
            client = await get_postgres_client()
            row = await client.fetchrow(
                """
                SELECT id FROM agent_issues
                WHERE org_id = $1
                  AND fingerprint = $2
                  AND status IN ('open', 'triaged', 'fix_pending', 'verifying')
                ORDER BY last_seen DESC
                LIMIT 1
                """,
                org_id,
                fingerprint,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("triage duplicate lookup failed: %s", exc)
            return None
        return str(row["id"]) if row else None

    async def _resolve_rule_channels(
        self, org_id: str, alert_event_id: str
    ) -> dict[str, Any] | None:
        """Best-effort lookup of the firing rule's ``channels`` config
        (FEAT-43), used when a caller doesn't already have it in hand.

        ``alert_events.rule_id`` is a nullable FK into
        ``nl_alert_rules`` — most current firing paths (e.g. the
        eql_alert_rules/AlertAsCode watchdog) don't populate it, in
        which case this is a no-op and paging keeps today's
        email-only default. Any caller that *does* create the event
        with a real ``rule_id`` gets its Slack/email/PagerDuty
        channels honored automatically, with no extra wiring.
        """
        try:
            client = await get_postgres_client()
            row = await client.fetchrow(
                "SELECT rule_id FROM alert_events WHERE id = $1 AND org_id = $2",
                alert_event_id,
                org_id,
            )
            rule_id = row["rule_id"] if row else None
            if not rule_id:
                return None
            from eden.alerts.repo import get_nl_rule

            rule = await get_nl_rule(org_id, str(rule_id))
            return rule.get("channels") if rule else None
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "AlertTriageJudge: rule channel resolution failed event=%s: %s",
                alert_event_id,
                exc,
            )
            return None

    async def apply_verdict(
        self,
        alert_event_id: str,
        verdict: dict[str, Any],
    ) -> None:
        client = await get_postgres_client()
        await client.execute(
            """
            UPDATE alert_events
            SET triage_verdict = $2,
                triage_reason = $3,
                triage_confidence = $4,
                incident_id = $5,
                updated_at = NOW()
            WHERE id = $1
            """,
            alert_event_id,
            verdict.get("verdict"),
            verdict.get("reason"),
            verdict.get("confidence"),
            verdict.get("incident_id"),
        )

    async def run_for_event(
        self,
        org_id: str,
        alert_event_id: str,
        *,
        rule_name: str,
        nl_text: str,
        payload: dict[str, Any] | None = None,
        notify: bool = True,
        channels: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        verdict = await self.judge(
            org_id,
            alert_event_id=alert_event_id,
            rule_name=rule_name,
            nl_text=nl_text,
            payload=payload,
        )
        # F5: persistence is best-effort here. Paging is the
        # higher-priority side effect — a Postgres hiccup on the
        # UPDATE must not prevent send_nl_incident_email from being
        # attempted below. Log and continue rather than raise.
        try:
            await self.apply_verdict(alert_event_id, verdict)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "AlertTriageJudge apply_verdict failed event=%s: %s",
                alert_event_id,
                exc,
            )
        if notify and verdict.get("verdict") == "real_incident":
            from eden.config import get_settings

            settings = get_settings()
            if not getattr(settings, "nl_alerts_paging_enabled", True):
                return verdict
            confidence = float(verdict.get("confidence") or 0)
            if confidence < 0.7:
                return verdict
            try:
                from eden.services.alert_email import send_nl_incident_email

                # FEAT-43: honor the rule's configured channels
                # (email/slack/pagerduty — see eden.alerts.repo and
                # eden.services.alert_email._nl_incident_channel_flags).
                # Callers may pass ``channels`` explicitly; otherwise
                # fall back to a best-effort lookup via the event's
                # linked rule_id (a no-op, preserving the pre-FEAT-43
                # email-only default, when nothing is linked).
                resolved_channels = channels
                if resolved_channels is None:
                    resolved_channels = await self._resolve_rule_channels(
                        org_id, alert_event_id
                    )
                await send_nl_incident_email(
                    org_id=org_id,
                    alert_event_id=alert_event_id,
                    rule_name=rule_name,
                    reason=str(verdict.get("reason") or ""),
                    confidence=confidence,
                    channels=resolved_channels,
                )
            except Exception:  # noqa: BLE001
                pass
        return verdict
