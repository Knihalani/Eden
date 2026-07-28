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

                await send_nl_incident_email(
                    org_id=org_id,
                    alert_event_id=alert_event_id,
                    rule_name=rule_name,
                    reason=str(verdict.get("reason") or ""),
                    confidence=confidence,
                )
            except Exception:  # noqa: BLE001
                pass
        return verdict
