"""Clerk webhook receiver.

Clerk sends a signed webhook (``svix``-style ``svix-id`` /
``svix-timestamp`` / ``svix-signature`` headers) for every auth
event we subscribed to in the Clerk dashboard:

- ``user.created`` / ``user.updated`` — sync the Clerk identity
  into Eden's ``users`` table. The Clerk ``id`` becomes the Eden
  ``user_id`` (which is also what ``get_current_user`` resolves
  from the session JWT ``sub`` claim).
- ``user.deleted`` — mark the Eden user as deactivated. We never
  hard-delete (audit log requirement).
- ``organization.created`` / ``organization.updated`` — sync the
  Clerk org to Eden's ``organizations`` table. The Clerk ``id`` is
  the Eden ``org_id``.
- ``organizationMembership.created`` / ``.updated`` — write the
  ``org_members`` row with the role mapped from Clerk's
  ``org:<slug>`` string onto Eden's ``owner``/``admin``/
  ``member``/``viewer`` ladder.
- ``organizationMembership.deleted`` — drop the ``org_members`` row
  but keep the user (they may belong to other orgs).

Verification uses Clerk's signing secret (configured via
``CLERK_WEBHOOK_SIGNING_SECRET``). When unset, the endpoint refuses
every request — a misconfigured secret should never let unsigned
payloads mutate production data.

Surface: ``POST /webhooks/clerk``.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from eden.api.utils.clerk_auth import clerk_role_to_eden_role
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])

_settings = get_settings()


def _verify_svix_signature(
    body: bytes,
    svix_id: str | None,
    svix_timestamp: str | None,
    svix_signature: str | None,
    secret: str,
) -> bool:
    """Verify a Clerk (svix) webhook signature.

    The signing secret is ``whsec_<base64>`` per svix's convention;
    strip the ``whsec_`` prefix and base64-decode to get the HMAC
    key. The signed payload is ``<svix_id>.<svix_timestamp>.<body>``.
    """
    if not (svix_id and svix_timestamp and svix_signature):
        return False
    if not secret.startswith("whsec_"):
        # Be lenient — some Clerk instances ship the secret without
        # the prefix. Treat the raw value as the HMAC key.
        key = secret.encode("utf-8")
    else:
        import base64

        try:
            key = base64.b64decode(secret.removeprefix("whsec_"))
        except Exception:
            return False

    signed = f"{svix_id}.{svix_timestamp}.".encode("utf-8") + body
    # Clerk may send multiple signatures (``v1,<base64>\nv1,<base64>``);
    # accept if ANY of them verify.
    for line in svix_signature.split():
        _, _, value = line.partition(",")
        if not value:
            continue
        try:
            import base64

            digest = hmac.new(key, signed, hashlib.sha256).digest()
            if hmac.compare_digest(digest, base64.b64decode(value)):
                return True
        except Exception:
            continue
    return False


async def _upsert_user(data: dict[str, Any]) -> None:
    """Sync a Clerk ``user`` payload into Eden's ``users`` table.

    We treat the Clerk ``id`` as the canonical ``user_id`` — it's
    the same value that ``get_current_user`` resolves from the
    session JWT's ``sub`` claim, so FK references line up.
    """
    clerk_id = data.get("id")
    if not clerk_id:
        return
    email = ""
    primary = data.get("primary_email_address_id")
    for addr in data.get("email_addresses", []):
        if addr.get("id") == primary or not email:
            email = addr.get("email_address", "") or email
    first = data.get("first_name") or ""
    last = data.get("last_name") or ""
    full = data.get("full_name") or " ".join(p for p in (first, last) if p) or email.split("@")[0]
    avatar = data.get("image_url") or ""

    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO users (id, email, name, avatar_url, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (id) DO UPDATE
        SET email = EXCLUDED.email,
            name = EXCLUDED.name,
            avatar_url = EXCLUDED.avatar_url,
            updated_at = NOW()
        """,
        clerk_id,
        email,
        full,
        avatar,
    )


async def _deactivate_user(data: dict[str, Any]) -> None:
    clerk_id = data.get("id")
    if not clerk_id:
        return
    client = await get_postgres_client()
    await client.execute(
        "UPDATE users SET deleted_at = NOW() WHERE id = $1",
        clerk_id,
    )


async def _upsert_org(data: dict[str, Any]) -> None:
    clerk_id = data.get("id")
    if not clerk_id:
        return
    name = data.get("name") or ""
    slug = data.get("slug") or clerk_id
    owner_id = ""
    # Clerk populates ``created_by`` for new orgs but the field is
    # on the membership, not the org itself. Best-effort: leave owner
    # blank until the membership.created event fires.
    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO organizations (id, name, slug, owner_id, archived_at, updated_at)
        VALUES ($1, $2, $3, NULL, NULL, NOW())
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            slug = EXCLUDED.slug,
            updated_at = NOW()
        """,
        clerk_id,
        name,
        slug,
    )
    # Stash the name on the org metadata for name lookups.
    _ = owner_id


async def _upsert_membership(data: dict[str, Any]) -> None:
    """Sync a Clerk ``organizationMembership`` payload to
    ``org_members`` with the role mapped onto Eden's vocab.
    """
    org_id = data.get("organization", {}).get("id") or data.get("organization_id")
    user_id = data.get("public_user_data", {}).get("user_id") or data.get("user_id")
    clerk_role = data.get("role") or "org:member"
    eden_role = clerk_role_to_eden_role(clerk_role)
    if not (org_id and user_id):
        return

    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO org_members (org_id, user_id, role, last_active_at, created_at)
        VALUES ($1, $2, $3, NOW(), NOW())
        ON CONFLICT (org_id, user_id) DO UPDATE
        SET role = EXCLUDED.role,
            last_active_at = NOW()
        """,
        org_id,
        user_id,
        eden_role,
    )


async def _delete_membership(data: dict[str, Any]) -> None:
    org_id = data.get("organization", {}).get("id") or data.get("organization_id")
    user_id = data.get("public_user_data", {}).get("user_id") or data.get("user_id")
    if not (org_id and user_id):
        return
    client = await get_postgres_client()
    await client.execute(
        "DELETE FROM org_members WHERE org_id = $1 AND user_id = $2",
        org_id,
        user_id,
    )


@router.post("/clerk")
async def clerk_webhook(
    request: Request,
    svix_id: str | None = Header(None, alias="svix-id"),
    svix_timestamp: str | None = Header(None, alias="svix-timestamp"),
    svix_signature: str | None = Header(None, alias="svix-signature"),
) -> dict[str, Any]:
    secret = getattr(_settings, "clerk_webhook_signing_secret", "")
    if not secret:
        logger.warning("Clerk webhook received but CLERK_WEBHOOK_SIGNING_SECRET is unset; rejecting.")
        raise HTTPException(status_code=503, detail="Clerk webhook signing secret not configured")

    body = await request.body()
    if not _verify_svix_signature(body, svix_id, svix_timestamp, svix_signature, secret):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    event = await request.json()
    event_type = event.get("type") or ""
    payload = event.get("data") or {}

    handlers = {
        "user.created": _upsert_user,
        "user.updated": _upsert_user,
        "user.deleted": _deactivate_user,
        "organization.created": _upsert_org,
        "organization.updated": _upsert_org,
        "organizationMembership.created": _upsert_membership,
        "organizationMembership.updated": _upsert_membership,
        "organizationMembership.deleted": _delete_membership,
    }
    handler = handlers.get(event_type)
    if handler is None:
        # Unknown event types are acknowledged (200) so Clerk doesn't
        # retry, but logged so we can wire them up later if needed.
        logger.info("Clerk webhook: ignoring unhandled event_type=%s", event_type)
        return {"status": "ignored", "event_type": event_type}

    try:
        await handler(payload)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Clerk webhook handler failed for %s: %s", event_type, exc)
        raise HTTPException(status_code=500, detail=f"Handler failed: {exc}")

    return {
        "status": "ok",
        "event_type": event_type,
        "received_at": datetime.utcnow().isoformat() + "Z",
    }