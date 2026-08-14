"""Slack App integration routes — Soft Autonomy alert delivery.

Routes:

* ``GET  /integrations/slack/configured``
    Public — whether this Eden instance has a Slack App wired up. The
    portal hides the "Connect Slack" button when false.
* ``GET  /integrations/slack/authorize``
    Owner/admin (``integrations:write``) — returns the Slack OAuth v2
    authorize URL + a CSRF state token (persisted on the org's
    ``onboarding_state`` row, same pattern as the GitHub flow).
* ``GET  /integrations/slack/callback``
    Public (Slack redirects here) — verifies state, exchanges the code,
    persists ``org_slack_installs`` (bot token encrypted), redirects
    back to the portal settings page.
* ``GET  /orgs/{org_id}/slack/install``
    Member — the org's active install (team name/id, no token).
* ``DELETE /orgs/{org_id}/slack/install``
    Owner/admin — disconnect (soft-revoke) the install.
* ``GET  /orgs/{org_id}/slack/channels``
    Owner/admin — live channel list from Slack (for the picker).
* ``GET  /orgs/{org_id}/slack/routes``
    Member — current agent→channel bindings.
* ``PUT  /orgs/{org_id}/slack/routes``
    Owner/admin — bind an agent (or the org default, agent_id=null) to
    a channel.
* ``DELETE /orgs/{org_id}/slack/routes``
    Owner/admin — clear a binding.
* ``POST /orgs/{org_id}/slack/test``
    Owner/admin — post a test message to the resolved channel.

Security notes:
* Bot tokens are Fernet-encrypted at rest (``org_slack_installs``).
* The callback is unauthenticated (Slack redirects the user); the
  ``state`` token is the only org identifier, so it is validated with
  the same strict regex + ambiguous-match refusal as the GitHub flow.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse, RedirectResponse

from eden.api.deps import (
    get_current_user,
    require_org_member,
    require_org_permission_dep,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.integrations.slack import (
    SlackAPIError,
    SlackConfigError,
    SlackOAuthClient,
    is_configured,
    verify_slack_signature,
)
from eden.integrations.slack import store as slack_store
from eden.integrations.slack.ambient import LISTEN_CHANNEL_TYPES, classify
from eden.integrations.slack.client import SlackClient
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

public_router = APIRouter(prefix="/integrations/slack", tags=["integrations"])
org_router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["slack"],
    dependencies=[Depends(require_path_org_access)],
)

#: Same shape guarantee as the GitHub oauth_state token: minted with
#: ``secrets.token_urlsafe`` (alphabet ``[A-Za-z0-9_-]``). Anything else
#: on the unauthenticated callback is refused before it touches SQL.
_SAFE_STATE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


class ConfiguredResponse(BaseModel):
    configured: bool = False
    dev_bot_token: bool = False


class AuthorizeResponse(BaseModel):
    authorize_url: str
    state: str


class InstallOut(BaseModel):
    team_id: str
    team_name: str
    bot_user_id: str = ""
    installed_at: str = ""
    granted_scopes: str = ""
    needs_reconsent: bool = False
    history_consented_at: str = ""


class ChannelOut(BaseModel):
    id: str
    name: str
    is_private: bool = False
    is_member: bool = False


class RouteOut(BaseModel):
    agent_id: str | None = None
    channel_id: str
    channel_name: str = ""


class SetRouteRequest(BaseModel):
    agent_id: str | None = Field(default=None, max_length=128)
    channel_id: str = Field(min_length=1, max_length=64)
    channel_name: str = Field(default="", max_length=128)


class ClearRouteRequest(BaseModel):
    agent_id: str | None = Field(default=None, max_length=128)


class TestMessageRequest(BaseModel):
    agent_id: str | None = Field(default=None, max_length=128)


def _portal_settings_url(**params: str) -> str:
    """Redirect target after OAuth — the portal settings workspace view
    (where the Slack card lives)."""
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return f"/settings{('?' + qs) if qs else ''}"


# ── Public: configured / authorize / callback ───────────────────────


@public_router.get("/configured", response_model=ConfiguredResponse)
async def slack_configured() -> ConfiguredResponse:
    """Public — does this Eden instance have a Slack App wired up?"""
    from eden.integrations.slack.oauth import has_dev_bot_token

    return ConfiguredResponse(
        configured=is_configured(),
        dev_bot_token=has_dev_bot_token(),
    )


@public_router.get("/authorize", response_model=AuthorizeResponse)
async def slack_authorize(
    request: Request,
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> AuthorizeResponse:
    """Return the Slack OAuth authorize URL + a CSRF state token.

    The state token is persisted on the org's ``onboarding_state`` row
    (piggyback, same as GitHub) so the unauthenticated callback can
    resolve which org the install belongs to.
    """
    if not is_configured():
        raise HTTPException(503, "Slack App is not configured on this Eden instance.")
    try:
        client = SlackOAuthClient()
    except SlackConfigError as exc:
        raise HTTPException(503, str(exc)) from exc
    state = client.new_state_token()
    authorize_url = client.get_authorize_url(state=state)

    pg = await get_postgres_client()
    existing = await pg.fetchrow(
        "SELECT completed_by_users FROM onboarding_state WHERE org_id = $1",
        org["org_id"],
    )
    completed: list[Any] = []
    if existing:
        raw = existing.get("completed_by_users") or []
        if isinstance(raw, str):
            raw = json.loads(raw)
        completed = list(raw)
    merged: list[Any] = [
        entry
        for entry in completed
        if not (isinstance(entry, dict) and "slack_oauth_state" in entry)
    ]
    merged.append({"slack_oauth_state": state})
    await pg.execute(
        """
        INSERT INTO onboarding_state (org_id, step, completed_by_users)
        VALUES ($1, 'connect_slack', $2::jsonb)
        ON CONFLICT (org_id) DO UPDATE
        SET completed_by_users = $2::jsonb,
            updated_at = NOW()
        """,
        org["org_id"],
        json.dumps(merged),
    )
    return AuthorizeResponse(authorize_url=authorize_url, state=state)


@public_router.get("/callback")
async def slack_callback(
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
):
    """Slack redirects the user here after they approve the install.

    Deliberately UNAUTHENTICATED — ``state`` is the only org identifier
    and is fully attacker-controlled, so it is validated strictly
    (shape regex + literal strpos match + ambiguous-match refusal),
    mirroring the hardened GitHub callback.
    """
    if not is_configured():
        raise HTTPException(503, "Slack App is not configured on this Eden instance.")
    if error:
        return RedirectResponse(
            url=_portal_settings_url(slack="denied"), status_code=302
        )
    if not code or not state or not _SAFE_STATE_RE.fullmatch(state):
        return RedirectResponse(
            url=_portal_settings_url(slack="state_not_found"), status_code=302
        )

    pg = await get_postgres_client()
    rows = await pg.fetch(
        """
        SELECT org_id FROM onboarding_state
        WHERE strpos(completed_by_users::text, $1) > 0
        LIMIT 2
        """,
        f'"slack_oauth_state": "{state}"',
    )
    if len(rows) != 1:
        if len(rows) > 1:
            logger.warning(
                "slack callback: state matched %d orgs; refusing to guess", len(rows)
            )
        return RedirectResponse(
            url=_portal_settings_url(slack="state_not_found"), status_code=302
        )
    org_id = str(rows[0]["org_id"])

    try:
        oauth = SlackOAuthClient()
        payload = await oauth.exchange_code(code)
    except (SlackAPIError, SlackConfigError) as exc:
        logger.warning("slack callback: code exchange failed: %s", redact_all(str(exc)))
        return RedirectResponse(
            url=_portal_settings_url(slack="exchange_failed"), status_code=302
        )

    team = payload.get("team") or {}
    bot_token = str(payload.get("access_token") or "")
    if not bot_token.startswith("xoxb-"):
        logger.warning("slack callback: unexpected token shape for org=%s", org_id)
        return RedirectResponse(
            url=_portal_settings_url(slack="exchange_failed"), status_code=302
        )
    await slack_store.upsert_install(
        org_id,
        team_id=str(team.get("id") or ""),
        team_name=str(team.get("name") or ""),
        bot_token=bot_token,
        bot_user_id=str(payload.get("bot_user_id") or ""),
        installed_by_user_id=None,
        granted_scopes=str(payload.get("scope") or ""),
    )
    # Consume the state so it can't be replayed.
    existing = await pg.fetchrow(
        "SELECT completed_by_users FROM onboarding_state WHERE org_id = $1",
        org_id,
    )
    if existing:
        raw = existing.get("completed_by_users") or []
        if isinstance(raw, str):
            raw = json.loads(raw)
        cleaned = [
            e
            for e in raw
            if not (isinstance(e, dict) and "slack_oauth_state" in e)
        ]
        await pg.execute(
            "UPDATE onboarding_state SET completed_by_users = $1::jsonb, "
            "updated_at = NOW() WHERE org_id = $2",
            json.dumps(cleaned),
            org_id,
        )
    return RedirectResponse(url=_portal_settings_url(slack="connected"), status_code=302)


# ── Org-scoped: install status / channels / routes / test ───────────


@org_router.get("/slack/install", response_model=InstallOut | None)
async def get_slack_install(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_member),
) -> InstallOut | None:
    """The org's active Slack install (no token), or null."""
    row = await slack_store.get_install(str(org["org_id"]))
    if row is None:
        return None
    return InstallOut(
        team_id=str(row.get("team_id") or ""),
        team_name=str(row.get("team_name") or ""),
        bot_user_id=str(row.get("bot_user_id") or ""),
        installed_at=str(row.get("installed_at") or ""),
        granted_scopes=str(row.get("granted_scopes") or ""),
        needs_reconsent=slack_store.needs_reconsent(row),
        history_consented_at=str(row.get("history_consented_at") or ""),
    )


@org_router.delete("/slack/install")
async def disconnect_slack(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> dict[str, str]:
    """Disconnect Slack (soft-revoke). Channel bindings are kept so
    reconnecting restores routing."""
    await slack_store.revoke_install(str(org["org_id"]))
    return {"status": "disconnected"}


@org_router.get("/slack/channels", response_model=list[ChannelOut])
async def list_slack_channels(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> list[ChannelOut]:
    """Live channel list from Slack for the portal channel picker."""
    token = await slack_store.get_bot_token(str(org["org_id"]))
    if not token:
        raise HTTPException(404, "Slack is not connected for this org.")
    try:
        channels = await SlackClient(token).list_channels()
    except SlackAPIError as exc:
        raise HTTPException(502, f"Slack API error: {exc.error or exc}") from exc
    return [ChannelOut(**ch) for ch in channels]


@org_router.get("/slack/routes", response_model=list[RouteOut])
async def get_slack_routes(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_member),
) -> list[RouteOut]:
    """Current agent→channel bindings (agent_id null = org default)."""
    rows = await slack_store.list_channels(str(org["org_id"]))
    return [
        RouteOut(
            agent_id=r.get("agent_id"),
            channel_id=str(r.get("channel_id") or ""),
            channel_name=str(r.get("channel_name") or ""),
        )
        for r in rows
    ]


@org_router.put("/slack/routes", response_model=RouteOut)
async def set_slack_route(
    req: SetRouteRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> RouteOut:
    """Bind an agent (or the org default) to a Slack channel."""
    ok = await slack_store.set_channel(
        str(org["org_id"]),
        agent_id=(req.agent_id or "").strip() or None,
        channel_id=req.channel_id.strip(),
        channel_name=req.channel_name.strip(),
        set_by_user_id=str(user.get("user_id") or "") or None,
    )
    if not ok:
        raise HTTPException(503, "Could not persist the channel binding.")
    return RouteOut(
        agent_id=(req.agent_id or "").strip() or None,
        channel_id=req.channel_id.strip(),
        channel_name=req.channel_name.strip(),
    )


@org_router.delete("/slack/routes")
async def clear_slack_route(
    req: ClearRouteRequest,
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> dict[str, str]:
    """Clear an agent's channel binding (or the org default)."""
    await slack_store.clear_channel(
        str(org["org_id"]), agent_id=(req.agent_id or "").strip() or None
    )
    return {"status": "cleared"}


@org_router.post("/slack/test")
async def send_slack_test(
    req: TestMessageRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> dict[str, str]:
    """Post a test alert to the channel the given agent resolves to."""
    from eden.services.slack_notify import send_test_message

    result = await send_test_message(
        str(org["org_id"]),
        agent_id=(req.agent_id or "").strip() or None,
        requested_by=str(user.get("email") or user.get("user_id") or ""),
    )
    if result.get("status") != "sent":
        raise HTTPException(
            502, f"Test message not sent: {result.get('reason') or 'unknown'}"
        )
    return result



def _slack_header(request: Request, name: str) -> str:
    return (
        request.headers.get(name)
        or request.headers.get(name.lower())
        or ""
    )


@public_router.post("/events")
async def slack_events(request: Request) -> JSONResponse:
    """Slack Events API receiver.

    Ack within 3s. Signature over the raw body. ``event_id`` idempotency.
    Subscribes conceptually to ``message.channels`` / ``message.groups``.
    Never handles ``message.im``. Stage 4 is off — keywords only.
    """
    from datetime import datetime

    from eden.config import get_settings

    if not is_configured():
        raise HTTPException(503, "Slack App is not configured on this Eden instance.")
    body = await request.body()
    settings = get_settings()
    secret = (getattr(settings, "slack_signing_secret", "") or "").strip()
    if not secret:
        raise HTTPException(503, "Slack signing secret is not configured.")
    ts = _slack_header(request, "X-Slack-Request-Timestamp")
    sig = _slack_header(request, "X-Slack-Signature")
    if not verify_slack_signature(
        body=body, timestamp=ts, signature=sig, secret=secret
    ):
        raise HTTPException(401, "invalid slack signature")

    try:
        payload = json.loads(body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "invalid json") from exc

    if not isinstance(payload, dict):
        raise HTTPException(400, "invalid json")

    if payload.get("type") == "url_verification":
        return JSONResponse({"challenge": payload.get("challenge") or ""})

    if payload.get("type") != "event_callback":
        return JSONResponse({"ok": True})

    event = payload.get("event") or {}
    if not isinstance(event, dict):
        return JSONResponse({"ok": True})

    # DMs off — never persist message.im
    channel_type = str(event.get("channel_type") or "")
    if channel_type == "im" or str(event.get("channel") or "").startswith("D"):
        return JSONResponse({"ok": True})

    if event.get("type") != "message":
        return JSONResponse({"ok": True})
    if channel_type and channel_type not in LISTEN_CHANNEL_TYPES:
        return JSONResponse({"ok": True})

    team_id = str(payload.get("team_id") or (payload.get("team") or {}).get("id") or "")
    org_id = await slack_store.get_org_id_for_team(team_id)
    if not org_id:
        return JSONResponse({"ok": True})

    event_id = str(payload.get("event_id") or "")
    if event_id and await slack_store.event_id_seen(org_id, event_id):
        return JSONResponse({"ok": True})

    channel_id = str(event.get("channel") or "")
    mapping = await slack_store.get_agent_for_channel(org_id, channel_id)
    if not mapping or not mapping.get("agent_id"):
        # Stage 1: unmapped (or org-default with no agent) — store nothing
        return JSONResponse({"ok": True})

    agent_id = str(mapping["agent_id"])
    contract = await slack_store.get_current_help_contract(org_id, agent_id)
    decision = classify(event=event, contract=contract)
    if decision.action != "fire" or not contract:
        return JSONResponse({"ok": True})

    message_ts = str(event.get("ts") or "")
    thread_ts = str(event.get("thread_ts") or message_ts)
    observed = datetime.now(UTC).isoformat()
    await slack_store.insert_extra_work_event(
        org_id,
        agent_id=agent_id,
        event_id=event_id or None,
        user_id=str(event.get("user") or "") or None,
        help_contract_id=str(contract.get("id") or "") or None,
        surface=decision.surface,
        kind=decision.kind,
        path=decision.path,
        join_key={
            "system": "slack",
            "slack_channel_id": channel_id,
            "slack_message_ts": message_ts,
            "slack_thread_ts": thread_ts,
        },
        snippet=decision.snippet,
        confidence=decision.confidence,
        polarity=decision.polarity,
        raw={
            "event_id": event_id,
            "ts": message_ts,
            "kind": decision.kind,
            "stage": 3,
        },
        observed_at=observed,
        session_id=None,
    )
    return JSONResponse({"ok": True})


__all__ = ["org_router", "public_router"]
