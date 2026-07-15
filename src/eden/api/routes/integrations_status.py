"""Org-scoped integration status rollup.

``GET /orgs/{org_id}/integrations/status`` — one call for the portal
settings banners and onboarding checklist. Aggregates instance-level
integration config with per-org wiring (GitHub installations, export
destinations).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_org_member
from eden.api.utils.redact import redact_all
from eden.integrations import INTEGRATION_API_VERSION, SUPPORTED_INTEGRATIONS
from eden.integrations.github import is_configured as github_is_configured
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/integrations",
    tags=["integrations"],
    dependencies=[Depends(get_current_user)],
)


class IntegrationStatusItem(BaseModel):
    id: str
    label: str
    enabled: bool
    configured: bool
    detail: str | None = None


class IntegrationsStatusResponse(BaseModel):
    integration_version: str
    integrations: list[IntegrationStatusItem]


def _instance_flags() -> dict[str, tuple[bool, str | None]]:
    from eden.config import get_settings

    settings = get_settings()
    return {
        "langfuse": (
            bool(
                getattr(settings, "langfuse_public_key", "")
                and getattr(settings, "langfuse_secret_key", "")
            ),
            getattr(settings, "langfuse_host", "https://cloud.langfuse.com"),
        ),
        "langsmith": (
            bool(getattr(settings, "langsmith_api_key", "")),
            getattr(settings, "langsmith_endpoint", "https://api.smith.langchain.com"),
        ),
        "wandb": (
            bool(getattr(settings, "wandb_api_key", "")),
            getattr(settings, "wandb_project", "eden"),
        ),
        "helicone": (
            bool(getattr(settings, "helicone_api_key", "")),
            None,
        ),
        "runloop": (
            bool(getattr(settings, "runloop_api_key", "")),
            getattr(settings, "runloop_sdk_module", "runloop"),
        ),
        "github_action": (
            github_is_configured(),
            None,
        ),
    }


async def _org_github_connected(org_id: str) -> bool:
    client = await get_postgres_client()
    if client is None:
        return False
    try:
        row = await client.fetchrow(
            """
            SELECT 1 FROM org_github_installations
            WHERE org_id = $1::uuid AND suspended_at IS NULL
            LIMIT 1
            """,
            org_id,
        )
        return row is not None
    except Exception as exc:
        logger.debug("integrations_status github lookup failed: %s", redact_all(str(exc)))
        return False


async def _org_export_destinations(org_id: str) -> int:
    client = await get_postgres_client()
    if client is None:
        return 0
    try:
        row = await client.fetchrow(
            """
            SELECT COUNT(*)::int AS n
            FROM export_destinations
            WHERE org_id = $1::uuid
            """,
            org_id,
        )
        return int(row["n"]) if row else 0
    except Exception as exc:
        logger.debug("integrations_status export lookup failed: %s", redact_all(str(exc)))
        return 0


async def _org_gateway_models(org_id: str) -> int:
    client = await get_postgres_client()
    if client is None:
        return 0
    try:
        row = await client.fetchrow(
            """
            SELECT COUNT(*)::int AS n
            FROM org_gateway_models
            WHERE org_id = $1::uuid AND enabled = TRUE
            """,
            org_id,
        )
        return int(row["n"]) if row else 0
    except Exception as exc:
        logger.debug("integrations_status gateway lookup failed: %s", redact_all(str(exc)))
        return 0


_LABELS: dict[str, str] = {
    "helicone": "Helicone",
    "wandb": "Weights & Biases",
    "langfuse": "Langfuse",
    "langsmith": "LangSmith",
    "runloop": "Runloop",
    "github_action": "GitHub",
    "discord": "Discord",
    "support_webhook": "Support webhook",
}


@router.get("/status", response_model=IntegrationsStatusResponse)
async def org_integrations_status(
    org_id: str = Path(...),
    _member: dict = Depends(require_org_member),
) -> IntegrationsStatusResponse:
    flags = _instance_flags()
    github_org = await _org_github_connected(org_id)
    export_count = await _org_export_destinations(org_id)

    items: list[IntegrationStatusItem] = []
    for integration_id in SUPPORTED_INTEGRATIONS:
        enabled, detail = flags.get(integration_id, (False, None))
        configured = enabled
        if integration_id == "github_action":
            configured = github_org
            if not enabled:
                detail = "GitHub App not configured on this Eden instance"
            elif not github_org:
                detail = "No active GitHub installation for this org"
        items.append(
            IntegrationStatusItem(
                id=integration_id,
                label=_LABELS.get(integration_id, integration_id),
                enabled=enabled,
                configured=configured,
                detail=detail,
            ),
        )

    # Portal-specific surfaces not in SUPPORTED_INTEGRATIONS tuple.
    items.append(
        IntegrationStatusItem(
            id="exports",
            label="Data exports",
            enabled=True,
            configured=export_count > 0,
            detail=(
                f"{export_count} destination(s)"
                if export_count
                else "No S3/GCS export destinations"
            ),
        ),
    )

    gateway_count = await _org_gateway_models(org_id)
    items.append(
        IntegrationStatusItem(
            id="gateway",
            label="AI Gateway",
            enabled=True,
            configured=gateway_count > 0,
            detail=(
                f"{gateway_count} upstream model(s)"
                if gateway_count
                else "No gateway models registered"
            ),
        ),
    )

    return IntegrationsStatusResponse(
        integration_version=INTEGRATION_API_VERSION,
        integrations=items,
    )


# ── Slack integration settings + test webhook (F47) ──────────────────


class SlackSettingsIn(BaseModel):
    webhook_url: str | None = None
    min_severity: str | None = None  # p0 | p1 | p2 | p3
    enabled: bool | None = None


def _mask_webhook(url: str | None) -> str | None:
    if not url:
        return None
    return url[:32] + "…" if len(url) > 32 else url


async def _load_slack_config(org_id: str) -> dict[str, Any]:
    client = await get_postgres_client()
    if client is None:
        return {}
    try:
        row = await client.fetchrow(
            "SELECT config, enabled FROM org_integrations "
            "WHERE org_id = $1 AND provider = 'slack' LIMIT 1",
            org_id,
        )
    except Exception as exc:
        logger.debug("slack settings: load failed: %s", redact_all(str(exc)))
        return {}
    if not row:
        return {}
    cfg = row.get("config") or {}
    if isinstance(cfg, str):
        import json

        try:
            cfg = json.loads(cfg)
        except (TypeError, ValueError):
            cfg = {}
    cfg = dict(cfg)
    cfg["enabled"] = bool(row.get("enabled"))
    return cfg


@router.get("/slack")
async def get_slack_settings(
    org_id: str = Path(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    cfg = await _load_slack_config(org_id)
    return {
        "provider": "slack",
        "configured": bool(cfg.get("webhook_url")),
        "enabled": bool(cfg.get("enabled")),
        "webhook_url_masked": _mask_webhook(cfg.get("webhook_url")),
        "min_severity": cfg.get("min_severity", "p1"),
    }


@router.patch("/slack")
async def patch_slack_settings(
    org_id: str = Path(...),
    body: SlackSettingsIn = ...,
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    import json

    client = await get_postgres_client()
    if client is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=503, detail="Database unavailable")
    current = await _load_slack_config(org_id)
    if body.webhook_url is not None:
        current["webhook_url"] = body.webhook_url
    if body.min_severity is not None:
        current["min_severity"] = body.min_severity
    enabled = body.enabled if body.enabled is not None else current.get("enabled", True)
    persist = {k: v for k, v in current.items() if k != "enabled"}
    try:
        await client.execute(
            """
            INSERT INTO org_integrations (org_id, provider, config, enabled)
            VALUES ($1, 'slack', $2::jsonb, $3)
            ON CONFLICT (org_id, provider)
            DO UPDATE SET config = EXCLUDED.config, enabled = EXCLUDED.enabled
            """,
            org_id,
            json.dumps(persist, default=str),
            bool(enabled),
        )
    except Exception as exc:
        logger.warning("slack settings: save failed: %s", redact_all(str(exc)))
        from fastapi import HTTPException

        raise HTTPException(status_code=500, detail="Failed to save Slack settings") from exc
    return await get_slack_settings(org_id, _member=_member)


@router.post("/slack/test")
async def test_slack_webhook(
    org_id: str = Path(...),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Send a Block Kit test message to the org's configured webhook."""
    from eden.integrations.slack.alerts import (
        _post,
        _resolve_webhook,
        validate_blocks,
    )

    from eden.config import get_settings

    webhook = await _resolve_webhook(org_id, get_settings())
    if not webhook:
        return {"status": "no_webhook", "delivered": False}
    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": ":white_check_mark: Eden Slack test",
                "emoji": True,
            },
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"Webhook is live for org `{org_id}`.",
            },
        },
    ]
    errors = validate_blocks(blocks)
    if errors:
        return {"status": "invalid_blocks", "delivered": False, "errors": errors}
    delivered = await _post(webhook, blocks, "test", "p3")
    return {"status": "ok" if delivered else "failed", "delivered": delivered}


__all__ = ["router"]
