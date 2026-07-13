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


__all__ = ["router"]
