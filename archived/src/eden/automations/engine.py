"""F61 automations engine — score threshold → dataset/queue/issue/alert."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

#: Outbound dispatch is inline in the real-time scoring path
#: (``rules_engine.py`` awaits ``on_score`` per scored trace), so
#: webhook/Slack calls must stay short: one retry, small timeout,
#: never block the caller for long.
_DISPATCH_TIMEOUT_S = 8.0
_DISPATCH_MAX_ATTEMPTS = 2
_DISPATCH_RETRY_BACKOFF_S = 0.5


class AutomationsEngine:
    """Unified automations on online scores and production events."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def list_automations(
        self, org_id: str, *, limit: int = 100
    ) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        capped = max(1, min(int(limit), 100))
        rows = await client.fetch(
            """
            SELECT id, org_id, name, trigger_type, trigger_config,
                   action_type, action_config, enabled, created_at, updated_at
            FROM automations
            WHERE org_id = $1
            ORDER BY updated_at DESC
            LIMIT $2
            """,
            org_id,
            capped,
        )
        return [dict(r) for r in rows]

    async def create(
        self,
        org_id: str,
        *,
        name: str,
        trigger_type: str = "score_threshold",
        trigger_config: dict[str, Any] | None = None,
        action_type: str = "dataset",
        action_config: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        aid = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO automations
            (id, org_id, name, trigger_type, trigger_config, action_type, action_config)
            VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
            """,
            aid,
            org_id,
            name,
            trigger_type,
            json.dumps(trigger_config or {}),
            action_type,
            json.dumps(action_config or {}),
        )
        return {"id": aid, "name": name, "trigger_type": trigger_type, "action_type": action_type}

    async def get_automation(
        self, org_id: str, automation_id: str
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            """
            SELECT id, org_id, name, trigger_type, trigger_config,
                   action_type, action_config, enabled, created_at, updated_at
            FROM automations
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            automation_id,
        )
        return dict(row) if row else None

    async def update_automation(
        self,
        org_id: str,
        automation_id: str,
        *,
        name: str | None = None,
        trigger_type: str | None = None,
        trigger_config: dict[str, Any] | None = None,
        action_type: str | None = None,
        action_config: dict[str, Any] | None = None,
        enabled: bool | None = None,
    ) -> dict[str, Any] | None:
        """Partial update; only fields explicitly passed (non-``None``) change."""
        existing = await self.get_automation(org_id, automation_id)
        if existing is None:
            return None
        client = await self._client()
        if client is None:
            return None
        new_name = name if name is not None else existing["name"]
        new_trigger_type = (
            trigger_type if trigger_type is not None else existing["trigger_type"]
        )
        new_trigger_config = (
            trigger_config
            if trigger_config is not None
            else dict(existing.get("trigger_config") or {})
        )
        new_action_type = (
            action_type if action_type is not None else existing["action_type"]
        )
        new_action_config = (
            action_config
            if action_config is not None
            else dict(existing.get("action_config") or {})
        )
        new_enabled = enabled if enabled is not None else existing["enabled"]
        await client.execute(
            """
            UPDATE automations SET
                name = $3, trigger_type = $4, trigger_config = $5::jsonb,
                action_type = $6, action_config = $7::jsonb, enabled = $8,
                updated_at = NOW()
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            automation_id,
            new_name,
            new_trigger_type,
            json.dumps(new_trigger_config),
            new_action_type,
            json.dumps(new_action_config),
            new_enabled,
        )
        return await self.get_automation(org_id, automation_id)

    async def toggle_automation(
        self, org_id: str, automation_id: str, *, enabled: bool
    ) -> dict[str, Any] | None:
        return await self.update_automation(org_id, automation_id, enabled=enabled)

    async def delete_automation(self, org_id: str, automation_id: str) -> bool:
        client = await self._client()
        if client is None:
            return False
        existing = await self.get_automation(org_id, automation_id)
        if existing is None:
            return False
        await client.execute(
            "DELETE FROM automations WHERE org_id = $1 AND id = $2::uuid",
            org_id,
            automation_id,
        )
        return True

    async def list_runs(
        self,
        org_id: str,
        *,
        automation_id: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        """List ``automation_runs`` for an org, optionally scoped to one
        automation. Paginated with a total count for the caller's
        next/prev controls (mirrors ``ci_eval_history`` pagination shape)."""
        client = await self._client()
        if client is None:
            return {"runs": [], "total": 0, "limit": limit, "offset": offset}
        capped_limit = max(1, min(int(limit), 200))
        capped_offset = max(0, int(offset))
        if automation_id:
            rows = await client.fetch(
                """
                SELECT id, org_id, automation_id, status, payload, created_at
                FROM automation_runs
                WHERE org_id = $1 AND automation_id = $2::uuid
                ORDER BY created_at DESC
                LIMIT $3 OFFSET $4
                """,
                org_id,
                automation_id,
                capped_limit,
                capped_offset,
            )
            total_row = await client.fetchrow(
                "SELECT count(*) AS n FROM automation_runs "
                "WHERE org_id = $1 AND automation_id = $2::uuid",
                org_id,
                automation_id,
            )
        else:
            rows = await client.fetch(
                """
                SELECT id, org_id, automation_id, status, payload, created_at
                FROM automation_runs
                WHERE org_id = $1
                ORDER BY created_at DESC
                LIMIT $2 OFFSET $3
                """,
                org_id,
                capped_limit,
                capped_offset,
            )
            total_row = await client.fetchrow(
                "SELECT count(*) AS n FROM automation_runs WHERE org_id = $1",
                org_id,
            )
        total = int(total_row["n"]) if total_row else len(rows)
        return {
            "runs": [dict(r) for r in rows],
            "total": total,
            "limit": capped_limit,
            "offset": capped_offset,
        }

    async def on_score(
        self,
        org_id: str,
        *,
        rule_id: str,
        trace_id: str,
        score: float,
        passed: bool,
    ) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            "SELECT * FROM automations WHERE org_id = $1 AND enabled = true",
            org_id,
        )
        fired: list[dict[str, Any]] = []
        for row in rows:
            trigger = dict(row.get("trigger_config") or {})
            if str(row.get("trigger_type")) != "score_threshold":
                continue
            min_score = trigger.get("min_score")
            max_score = trigger.get("max_score")
            require_fail = bool(trigger.get("require_fail"))
            rule_match = trigger.get("rule_id")
            if rule_match and str(rule_match) != rule_id:
                continue
            if min_score is not None and score < float(min_score):
                continue
            if max_score is not None and score > float(max_score):
                continue
            if require_fail and passed:
                continue
            result = await self._execute_action(
                org_id,
                str(row["action_type"]),
                dict(row.get("action_config") or {}),
                trace_id=trace_id,
                score=score,
            )
            run_id = await self._log_run(org_id, str(row["id"]), result)
            fired.append({"automation_id": str(row["id"]), "run_id": run_id, **result})
        return fired

    async def _execute_action(
        self,
        org_id: str,
        action_type: str,
        config: dict[str, Any],
        *,
        trace_id: str,
        score: float,
    ) -> dict[str, Any]:
        if action_type == "dataset":
            dataset_name = str(config.get("dataset_name") or "automation-captures")
            try:
                from eden.datasets.hub import DatasetHub

                hub = DatasetHub(pg=self._pg)
                result = await hub.promote_trace(
                    org_id, trace_id, dataset_name=dataset_name
                )
                return {"action": "dataset", "result": result}
            except Exception as exc:
                logger.debug("automations: dataset action failed: %s", exc)
                return {"action": "dataset", "error": str(exc)}
        if action_type == "queue":
            queue_id = config.get("queue_id")
            return {
                "action": "queue",
                "status": "completed",
                "queue_id": queue_id,
                "trace_id": trace_id,
            }
        if action_type == "alert":
            return await self._dispatch_alert(
                org_id, config, trace_id=trace_id, score=score
            )
        if action_type == "webhook":
            return await self._dispatch_webhook(
                org_id, config, trace_id=trace_id, score=score
            )
        if action_type == "slack":
            return await self._dispatch_slack(
                org_id, config, trace_id=trace_id, score=score
            )
        return {
            "action": action_type,
            "status": "completed",
            "trace_id": trace_id,
            "score": score,
        }

    async def _dispatch_http(
        self,
        url: str,
        *,
        json_payload: dict[str, Any],
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """POST ``json_payload`` to ``url``. Never raises.

        Guards against SSRF the same way the outbound webhook-delivery
        outbox does (see :func:`eden.services.webhook_delivery._assert_public_ip`),
        applies a short timeout, and retries once on transport failure /
        non-2xx before giving up — this call is awaited inline in the
        real-time scoring path so it must fail fast, not queue for
        later like the full webhook outbox does.
        """
        try:
            from eden.services.webhook_delivery import _assert_public_ip

            _assert_public_ip(url)
        except ValueError as exc:
            return {"status": "error", "error": f"webhook url rejected: {exc}"}
        except Exception as exc:  # pragma: no cover - import/helper failure
            logger.warning("automations: SSRF guard unavailable: %s", exc)
            return {
                "status": "error",
                "error": "webhook url rejected: SSRF guard unavailable",
            }

        try:
            from eden.util.shared_http import shared_httpx_ctx
        except ImportError as exc:  # pragma: no cover - always installed
            return {"status": "error", "error": str(exc)}

        body = json.dumps(json_payload, default=str).encode("utf-8")
        send_headers = {"Content-Type": "application/json", **(headers or {})}
        last_error = "unknown error"
        for attempt in range(1, _DISPATCH_MAX_ATTEMPTS + 1):
            try:
                async with shared_httpx_ctx(timeout=_DISPATCH_TIMEOUT_S) as client:
                    resp = await client.post(url, content=body, headers=send_headers)
                if 200 <= resp.status_code < 300:
                    return {"status": "sent", "http_status": resp.status_code}
                last_error = f"HTTP {resp.status_code}"
            except Exception as exc:  # noqa: BLE001 - never crash the engine
                last_error = str(exc)[:300]
            if attempt < _DISPATCH_MAX_ATTEMPTS:
                await asyncio.sleep(_DISPATCH_RETRY_BACKOFF_S)
        logger.warning("automations: dispatch to %s failed: %s", url, last_error)
        return {"status": "error", "error": last_error}

    async def _dispatch_alert(
        self,
        org_id: str,
        config: dict[str, Any],
        *,
        trace_id: str,
        score: float,
    ) -> dict[str, Any]:
        """Email alert action — routes through FEAT-44 ``dispatch_unified_alert``."""
        message = str(config.get("message") or "score threshold breached")
        severity = str(config.get("severity") or "P1").upper()
        title = str(config.get("title") or "Automation alert")
        detail = (
            f"Automation triggered on trace {trace_id} "
            f"(score={score:.3f}): {message}"
        )
        try:
            from eden.alerts.unified import (
                AlertDestination,
                UnifiedAlertRouteRequest,
                UnifiedDestinationKind,
                dispatch_unified_alert,
            )

            result = await dispatch_unified_alert(
                UnifiedAlertRouteRequest(
                    org_id=org_id,
                    severity=severity,
                    title=title,
                    message=detail,
                    event_kind="automation_triggered",
                    issue_id=trace_id,
                    entity_id=trace_id,
                    destinations=[
                        AlertDestination(kind=UnifiedDestinationKind.EMAIL)
                    ],
                    extra={
                        "trace_id": trace_id,
                        "score": score,
                        "message": message,
                    },
                )
            )
            email = result.by_kind(UnifiedDestinationKind.EMAIL)
            if email and email.status == "sent":
                return {
                    "action": "alert",
                    "status": "sent",
                    "trace_id": trace_id,
                    "score": score,
                    "message": message,
                    "severity": severity,
                    "recipient_count": email.detail.get("recipient_count", 0),
                }
            return {
                "action": "alert",
                "status": "error",
                "error": (email.error if email else "email dispatch failed"),
                "trace_id": trace_id,
                "score": score,
                "message": message,
            }
        except Exception as exc:  # noqa: BLE001 - never crash the engine
            logger.warning("automations: alert action failed org=%s: %s", org_id, exc)
            return {
                "action": "alert",
                "status": "error",
                "error": str(exc)[:300],
                "trace_id": trace_id,
                "score": score,
                "message": message,
            }

    async def _dispatch_webhook(
        self,
        org_id: str,
        config: dict[str, Any],
        *,
        trace_id: str,
        score: float,
    ) -> dict[str, Any]:
        """Generic outbound webhook — the ``"webhook"`` action offered by
        the portal Automations dialog. ``config`` is the user-supplied
        JSON action config; ``url`` (or ``webhook_url``) is required,
        ``headers`` and a free-form ``payload`` template are optional."""
        url = str(config.get("url") or config.get("webhook_url") or "").strip()
        if not url:
            return {
                "action": "webhook",
                "status": "error",
                "error": "action_config.url is required for webhook actions",
                "trace_id": trace_id,
            }
        headers = config.get("headers")
        headers = headers if isinstance(headers, dict) else None
        extra = config.get("payload")
        payload = {
            "event": "automation.triggered",
            "org_id": org_id,
            "trace_id": trace_id,
            "score": score,
            **(extra if isinstance(extra, dict) else {}),
        }
        result = await self._dispatch_http(url, json_payload=payload, headers=headers)
        return {"action": "webhook", "trace_id": trace_id, "url": url, **result}

    async def _dispatch_slack(
        self,
        org_id: str,
        config: dict[str, Any],
        *,
        trace_id: str,
        score: float,
    ) -> dict[str, Any]:
        """Slack action — the ``"slack"`` action offered by the portal
        Automations dialog.

        Two ways to reach Slack, tried in this order:

        1. ``config["webhook_url"]`` (or ``"url"``) — a customer-supplied
           Slack Incoming Webhook URL, self-service and requires no
           connected Slack App.
        2. The org's connected Slack App (``eden.integrations.slack`` /
           migration 131), the same bot-token + channel-binding path
           :mod:`eden.services.slack_notify` uses for issue/PR alerts.
           ``config["channel_id"]`` / ``config["agent_id"]`` can target a
           specific channel binding; otherwise the org default is used.
        """
        message = str(
            config.get("message")
            or config.get("text")
            or f"Eden automation triggered: score={score:.3f} trace={trace_id}"
        )
        webhook_url = str(config.get("webhook_url") or config.get("url") or "").strip()
        if webhook_url:
            result = await self._dispatch_http(
                webhook_url, json_payload={"text": message}
            )
            return {
                "action": "slack",
                "channel": "incoming_webhook",
                "trace_id": trace_id,
                **result,
            }

        try:
            from eden.integrations.slack import store as slack_store
            from eden.integrations.slack.client import SlackClient

            channel_id = config.get("channel_id")
            if not channel_id:
                agent_id = config.get("agent_id")
                channel = await slack_store.get_channel(org_id, agent_id=agent_id)
                channel_id = channel.get("channel_id") if channel else None
            if not channel_id:
                return {
                    "action": "slack",
                    "status": "error",
                    "error": "no Slack channel configured for this org "
                    "(connect Slack or set action_config.webhook_url)",
                    "trace_id": trace_id,
                }
            token = await slack_store.get_bot_token(org_id)
            if not token:
                return {
                    "action": "slack",
                    "status": "error",
                    "error": "Slack is not connected for this org",
                    "trace_id": trace_id,
                }
            resp = await SlackClient(token).post_message(
                channel=str(channel_id), text=message
            )
            return {
                "action": "slack",
                "status": "sent",
                "channel_id": str(channel_id),
                "trace_id": trace_id,
                "ts": str(resp.get("ts") or ""),
            }
        except Exception as exc:  # noqa: BLE001 - never crash the engine
            logger.warning("automations: slack action failed org=%s: %s", org_id, exc)
            return {
                "action": "slack",
                "status": "error",
                "error": str(exc)[:300],
                "trace_id": trace_id,
            }

    async def _log_run(
        self, org_id: str, automation_id: str, payload: dict[str, Any]
    ) -> str | None:
        client = await self._client()
        if client is None:
            return None
        rid = str(uuid.uuid4())
        # Surface dispatch failures on the run record itself
        # (``automation_runs.status``, default ``'completed'`` — see
        # migration 102) so a failed webhook/Slack/dataset dispatch is
        # visible without having to grep logs. ``_execute_action`` sets
        # ``status: "error"`` on failure; the older dataset-failure shape
        # (``{"error": ...}`` with no ``status`` key) is treated as failed
        # too for backward compatibility.
        status = "failed" if (payload.get("status") == "error" or payload.get("error")) else "completed"
        try:
            await client.execute(
                """
                INSERT INTO automation_runs (id, org_id, automation_id, status, payload)
                VALUES ($1::uuid, $2, $3::uuid, $4, $5::jsonb)
                """,
                rid,
                org_id,
                automation_id,
                status,
                json.dumps(payload),
            )
            return rid
        except Exception:
            return None
