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
- ``organization.deleted`` — soft-archive the Eden org
  (``archived_at = NOW()``), matching portal archive semantics.
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

Idempotency: ``svix-id`` is claimed in Redis (``clerk:svix:{id}``,
SET NX EX 86400). Duplicates return 200 without reprocessing; the
key is released on handler failure so Clerk retries can succeed.

Surface: ``POST /webhooks/clerk``.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from eden.api.utils.clerk_auth import clerk_role_to_eden_role
from eden.api.utils.clerk_client import invalidate_user_cache
from eden.api.utils.redact import redact_all
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])

_SVIX_IDEMPOTENCY_TTL_S = 86400


async def _claim_svix_id(svix_id: str | None) -> bool:
    """Claim a Svix delivery id. Return False if already processed."""
    if not svix_id:
        return True
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is None:
            return True
        was_set = await redis.set(
            f"clerk:svix:{svix_id}",
            "1",
            nx=True,
            ex=_SVIX_IDEMPOTENCY_TTL_S,
        )
        return bool(was_set)
    except Exception as exc:  # noqa: BLE001 — fail open on redis blips
        logger.debug("clerk svix idempotency claim failed: %s", exc)
        return True


async def _release_svix_id(svix_id: str | None) -> None:
    """Drop the claim so Clerk can redeliver after a 503/handler failure."""
    if not svix_id:
        return
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is None:
            return
        await redis.delete(f"clerk:svix:{svix_id}")
    except Exception as exc:  # noqa: BLE001
        logger.debug("clerk svix idempotency release failed: %s", exc)


class WebhookNotReadyError(RuntimeError):
    """A referenced row has not been created yet; ask for redelivery.

    Clerk events arrive without ordering guarantees, so a membership
    event can beat the user.created that owns its user. The handlers
    used to log this and return, and the route then answered HTTP 200.

    Svix (which Clerk uses for delivery) redelivers on non-2xx ONLY — a
    200 is a permanent acknowledgement. So every out-of-order event was
    silently discarded, and the row it would have written never
    appeared. Raising instead produces a 503 and Svix retries on its
    own backoff schedule, which spans hours: far more than enough for
    the ordering gap this absorbs.
    """

_settings = get_settings()
# Public alias for tests that need to monkeypatch the secret at runtime
# (the private ``_settings`` is captured at import time, so direct
# ``monkeypatch.setattr`` on it is harmless, but the test files use
# ``clerk_webhooks.settings`` for clarity).  Keep both in sync via
# attribute assignment, not a re-import, so the secret is read from
# the same singleton on every request.
settings = _settings


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

    Replay window: svix ships a 5-minute server-side tolerance for
    ``svix_timestamp`` drift. We enforce the same window here so a
    captured-and-replayed webhook payload (signature still valid,
    timestamp frozen in the past) is rejected before the handler
    runs. Without this, ``user.deleted`` / ``organization.deleted``
    could be replayed indefinitely to re-soft-delete users or wipe
    membership rows even after Clerk has rotated its signing key.
    """
    if not (svix_id and svix_timestamp and svix_signature):
        return False
    # Reject stale or far-future timestamps before doing the
    # (expensive) HMAC verification. 5 minutes matches the svix
    # default; widen via env if your NTP drift is genuinely worse.
    try:
        ts = int(svix_timestamp)
    except (TypeError, ValueError):
        return False
    import time as _time

    if abs(_time.time() - ts) > 300:
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

    signed = f"{svix_id}.{svix_timestamp}.".encode() + body
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

    The Clerk ``id`` (``user_2abc...``) is stored in the new
    ``clerk_id`` column (added in migration 047); the primary key
    ``users.id`` stays a generated UUID so all the FK references
    (``org_members.user_id``, ``organizations.owner_id``,
    ``notifications.user_id``, ...) keep pointing at the same row.

    Two-step upsert:

    1. ``INSERT ... ON CONFLICT (clerk_id) DO UPDATE`` — handles
       re-deliveries for the same Clerk user (idempotent) and
       catches the common case where ``/auth/me`` auto-provision
       raced the webhook and won.
    2. If the INSERT fails with ``users_email_key`` (a fresh
       Clerk signup reusing an email that already has a row in
       Eden under a *different* clerk_id — the user deleted and
       re-signed up, or Clerk minted a new id for the same email
       for some other reason), re-claim the existing row by
       updating its clerk_id if and only if the existing row is
       soft-deleted. Active rows with a different clerk_id are
       left alone — that's a real conflict the operator needs to
       resolve manually.

    ``password_hash`` is NULL for Clerk-managed users — they
    authenticate via Clerk, never via Eden's password flow.
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
    try:
        await client.execute(
            """
            INSERT INTO users (clerk_id, email, name, avatar_url, password_hash)
            VALUES ($1, $2, $3, $4, NULL)
            ON CONFLICT (clerk_id) DO UPDATE
            SET email = EXCLUDED.email,
                name = EXCLUDED.name,
                avatar_url = EXCLUDED.avatar_url,
                deleted_at = NULL
            """,
            clerk_id,
            email,
            full,
            avatar,
        )
        return
    except Exception as exc:
        # Email already exists under a different clerk_id. If that
        # row is soft-deleted, re-claim it (Clerk is the source of
        # truth for who owns the email now). If it's active, the
        # operator needs to resolve the conflict manually — log and
        # bail so we don't silently overwrite a live user.
        msg = str(exc).lower()
        if "users_email_key" not in msg and "duplicate key" not in msg:
            raise
        status = await client.execute(
            """
            UPDATE users SET
                clerk_id   = $1,
                name       = COALESCE(NULLIF($3, ''), users.name),
                avatar_url = COALESCE(NULLIF($4, ''), users.avatar_url),
                deleted_at = NULL
            WHERE email = $2 AND deleted_at IS NOT NULL
            """,
            clerk_id,
            email,
            full,
            avatar,
        )
        # The WHERE only matches a SOFT-DELETED row. When the conflicting
        # row is active this updates nothing — and the docstring above
        # promised to "log and bail", but nothing was ever logged and the
        # route answered 200. So a genuine identity collision looked
        # exactly like a successful sync, and the user row was never
        # created. Say so, loudly.
        if str(status).strip().upper() in {"UPDATE 0", "UPDATE"}:
            logger.error(
                "_upsert_user: email already belongs to a DIFFERENT ACTIVE "
                "user; refusing to overwrite. clerk_id=%s. An operator must "
                "resolve this collision manually.",
                clerk_id,
            )
            raise WebhookNotReadyError(
                "email is already claimed by an active user"
            ) from exc


async def _deactivate_user(data: dict[str, Any]) -> None:
    """Mark a Clerk user as soft-deleted in Eden.

    Looks up by ``clerk_id`` (the Clerk string id, e.g. ``user_2abc...``),
    NOT by ``users.id`` (which is a generated UUID). The earlier
    implementation queried by ``id`` — that matched no rows because the
    Clerk id never matches the UUID PK, so every ``user.deleted``
    webhook silently no-op'd. Soft-delete is irreversible through
    the API (audit log requirement) but the operator can clear
    ``deleted_at`` to restore the row if the Clerk user comes back.
    """
    clerk_id = data.get("id")
    if not clerk_id:
        return
    client = await get_postgres_client()
    result = await client.execute(
        "UPDATE users SET deleted_at = NOW() WHERE clerk_id::text = $1",
        clerk_id,
    )
    # ``result`` is the asyncpg status string ("UPDATE N") — log
    # silently if no row matched so a future operator can spot a
    # webhook delivery that targeted a clerk_id we don't have.
    if result.endswith(" 0"):
        logger.info(
            "_deactivate_user: no row matched clerk_id=%s; webhook "
            "delivery for a user that was never auto-provisioned",
            clerk_id,
        )


async def _upsert_org(data: dict[str, Any]) -> None:
    """Sync a Clerk ``organization`` payload to the ``organizations`` table.

    Three arrival orders are possible:

    1. **Webhook first (Clerk-created)** — Clerk org was created via
       the dashboard (or any path other than Eden's ``POST /orgs``).
       No Eden row exists yet. The conditional INSERT below only
       fires when ``clerk_id`` looks like a UUID (the format Clerk
       emits when no custom id is passed to its Backend API). When
       Clerk uses its default ``org_2x...`` string format, we skip
       the insert and rely on Eden's ``POST /orgs`` to have written
       the row first (case 2).

    2. **Backend row first** — Eden's ``POST /orgs`` wrote a row
       with ``id = uuid4()`` and ``clerk_org_id = clerk_id`` (from
       the synchronous Clerk call), then the webhook arrives. The
       ``UPDATE`` below matches on ``clerk_org_id`` and refreshes
       ``name``/``slug`` (idempotent if the row is already linked).

    3. **Legacy row** — webhook-created orgs from before migration
       038 have ``clerk_org_id IS NULL`` and ``id = clerk_id``
       (Postgres's UUID column accepted whatever Clerk sent).
       Backfilled by the second UPDATE condition.

    The INSERT deliberately refuses to insert non-UUID ``clerk_id``
    values to avoid ``invalid input syntax for type uuid`` errors
    that would otherwise surface as webhook delivery failures.
    """
    clerk_id = data.get("id")
    if not clerk_id:
        return
    name = data.get("name") or ""
    slug = data.get("slug") or clerk_id
    client = await get_postgres_client()

    # Resolve Eden owner for INSERT (owner_id is NOT NULL).
    eden_owner_id: str | None = None
    created_by = data.get("created_by")
    if created_by:
        owner_row = await client.fetchrow(
            "SELECT id FROM users WHERE clerk_id::text = $1",
            str(created_by),
        )
        if owner_row:
            eden_owner_id = str(owner_row["id"])

    # Cases 2 + 3: refresh name/slug on the matching row. Idempotent
    # for case 2 (already linked) and case 3 (legacy). The
    # ``NOT EXISTS`` guard makes this a no-op if no row matches.
    await client.execute(
        """
        UPDATE organizations
        SET name = $3, slug = $4, updated_at = NOW()
        WHERE (clerk_org_id = $1)
           OR (clerk_org_id IS NULL AND id::text = $1)
        """,
        clerk_id,
        clerk_id,
        name,
        slug,
    )

    # Case 1: insert if no row exists. Always mint a UUID ``id`` and
    # store the Clerk string in ``clerk_org_id`` — Clerk's default
    # ``org_2x…`` ids are not UUIDs and must never be cast to one.
    # ``owner_id`` is NOT NULL — skip INSERT when we cannot resolve
    # the creator yet; ``/auth/me`` self-heal or the membership
    # webhook will create the row once a user exists.
    if not eden_owner_id:
        # owner_id is NOT NULL, so we cannot INSERT without a creator.
        # But the UPDATE above may already have handled this event: for
        # an org row that exists, refreshing name/slug IS the whole job
        # and there is nothing left to do. Only a genuinely absent row
        # is unfinished work.
        exists = await client.fetchrow(
            """
            SELECT 1 FROM organizations
            WHERE clerk_org_id = $1 OR id::text = $1
            """,
            clerk_id,
        )
        if exists:
            return

        # No row, and no creator to hang one off. Skipping used to fall
        # through to a 200, which Svix treats as a permanent ack — the
        # organization.created event was dropped for good. Ask for
        # redelivery instead; by then user.created will have landed.
        logger.warning(
            "_upsert_org: creator not in users yet for clerk_org=%s; "
            "asking Clerk to redeliver",
            clerk_id,
        )
        raise WebhookNotReadyError(
            "organization creator has not been created yet"
        )

    if eden_owner_id:
        await client.execute(
            """
            INSERT INTO organizations
                (id, clerk_org_id, name, slug, owner_id, archived_at, updated_at)
            SELECT gen_random_uuid(), $1, $2, $3, $4, NULL, NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM organizations
                WHERE clerk_org_id = $1 OR id::text = $1
            )
            """,
            clerk_id,
            name,
            slug,
            eden_owner_id,
        )


async def _upsert_membership(data: dict[str, Any]) -> None:
    """Sync a Clerk ``organizationMembership`` payload to
    ``org_members`` with the role mapped onto Eden's vocab.

    Translation: the Clerk webhook delivers ``org_id`` and
    ``user_id`` as Clerk string ids (``org_2x...`` / ``user_2abc...``).
    Eden's ``org_members.org_id`` is UUID (FK to ``organizations.id``)
    and ``user_id`` is TEXT (FK to ``users.id``), so we
    translate via ``organizations.clerk_org_id`` and
    ``users.clerk_id`` before writing. If either lookup misses we
    raise :class:`WebhookNotReadyError` so the route answers 503 and
    Svix redelivers. Returning silently here answered 200, which Svix
    treats as a permanent ack — the event was then dropped for good.

    Role-write conflict resolution: the initial ``organizationMembership.created``
    webhook can fire within milliseconds of Eden's local
    ``accept_invitation`` / ``create_org`` insert. If Eden wrote the
    row first with ``last_writer_source = 'local'`` (e.g. owner or
    invitee ``viewer``), the role mapping ``org:member → member`` in
    ``clerk_role_to_eden_role`` would overwrite the local role. The
    ``DO UPDATE`` below:

    1. Skips role overwrite while ``last_writer_source = 'local'``.
    2. Only flips ``last_writer_source`` to ``'clerk'`` once Clerk's
       mapped role *agrees* with the local row (or Clerk already owns
       the row). Flipping on every arrival while preserving a stronger
       local role previously let a second webhook / self-heal with a
       weaker claim demote ``owner`` → ``member``.
    """
    clerk_org_id = data.get("organization", {}).get("id") or data.get("organization_id")
    clerk_user_id = data.get("public_user_data", {}).get("user_id") or data.get("user_id")
    clerk_role = data.get("role") or "org:member"
    eden_role = clerk_role_to_eden_role(clerk_role)
    if not (clerk_org_id and clerk_user_id):
        return

    client = await get_postgres_client()
    # Translate Clerk string ids → Eden UUIDs. Both lookups are
    # idempotent and bounded by an index on the clerk_* column.
    # If either side misses (org or user not yet created in Eden),
    # bail so the dependent ``user.created`` / ``organization.created``
    # webhook can land first; Clerk will redeliver this membership
    # event and the second pass will succeed.
    eden_user = await client.fetchrow(
        "SELECT id FROM users WHERE clerk_id::text = $1",
        clerk_user_id,
    )
    eden_org = await client.fetchrow(
        """
        SELECT id FROM organizations
        WHERE clerk_org_id::text = $1 OR id::text = $1
        LIMIT 1
        """,
        clerk_org_id,
    )
    if not eden_user or not eden_org:
        # This used to `return`, and the route then answered HTTP 200.
        # The old comment here claimed "Clerk will redeliver after
        # user.created or organization.created lands" — that is simply
        # not how Svix works. Svix redelivers on non-2xx only; a 200 is
        # a permanent acknowledgement, so the event was lost forever and
        # the membership row was never written. Two production orgs have
        # zero members as a direct result.
        #
        # Raising makes the route answer 503, which Svix retries with
        # backoff (roughly 5s, 5m, 30m, 2h, 5h, 10h) — far longer than
        # the ordering gap this is trying to absorb.
        logger.warning(
            "_upsert_membership: missing side (user=%s org=%s) for "
            "clerk_user=%s clerk_org=%s; asking Clerk to redeliver",
            bool(eden_user),
            bool(eden_org),
            clerk_user_id,
            clerk_org_id,
        )
        raise WebhookNotReadyError(
            "referenced user or organization has not been created yet"
        )

    eden_org_id = eden_org["id"]
    eden_user_id = eden_user["id"]

    await client.execute(
        """
        INSERT INTO org_members (
            org_id, user_id, role, last_active_at, joined_at, last_writer_source
        )
        VALUES ($1, $2, $3, NOW(), NOW(), 'clerk')
        ON CONFLICT (org_id, user_id) DO UPDATE
        SET role = CASE
                WHEN org_members.last_writer_source = 'clerk'
                    THEN EXCLUDED.role
                ELSE org_members.role
            END,
            last_writer_source = CASE
                WHEN org_members.last_writer_source = 'clerk'
                    THEN 'clerk'
                WHEN org_members.role = EXCLUDED.role
                    THEN 'clerk'
                ELSE org_members.last_writer_source
            END,
            last_active_at = NOW()
        """,
        eden_org_id,
        eden_user_id,
        eden_role,
    )


async def _delete_membership(data: dict[str, Any]) -> None:
    clerk_org_id = data.get("organization", {}).get("id") or data.get("organization_id")
    clerk_user_id = data.get("public_user_data", {}).get("user_id") or data.get("user_id")
    if not (clerk_org_id and clerk_user_id):
        return
    client = await get_postgres_client()
    # Translate via the lookup tables; if either side is missing we
    # simply have no row to delete (Clerk memberships exist only in
    # Clerk) and the no-op delete is the correct behaviour.
    row = await client.fetchrow(
        """
        SELECT om.org_id, om.user_id
        FROM org_members om
        JOIN organizations o ON o.id = om.org_id
        JOIN users u ON u.id = om.user_id
        WHERE (o.clerk_org_id = $1 OR o.id::text = $1)
          AND u.clerk_id = $2
        LIMIT 1
        """,
        clerk_org_id,
        clerk_user_id,
    )
    if not row:
        return
    await client.execute(
        "DELETE FROM org_members WHERE org_id = $1 AND user_id = $2",
        row["org_id"],
        row["user_id"],
    )


async def _archive_org(data: dict[str, Any]) -> None:
    """Soft-archive an Eden org when Clerk sends ``organization.deleted``.

    Matches portal archive semantics (``archived_at``), not hard DELETE.
    Idempotent when the row is already archived or missing.
    """
    clerk_id = data.get("id")
    if not clerk_id:
        return
    client = await get_postgres_client()
    await client.execute(
        """
        UPDATE organizations
        SET archived_at = NOW(), updated_at = NOW()
        WHERE archived_at IS NULL
          AND (clerk_org_id = $1 OR id::text = $1)
        """,
        clerk_id,
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
        logger.warning(
            "Clerk webhook received but CLERK_WEBHOOK_SIGNING_SECRET is unset; rejecting."
        )
        raise HTTPException(status_code=503, detail="Clerk webhook signing secret not configured")

    body = await request.body()
    if not _verify_svix_signature(body, svix_id, svix_timestamp, svix_signature, secret):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    if not await _claim_svix_id(svix_id):
        return {"status": "ok", "duplicate": True, "svix_id": svix_id}

    event = await request.json()
    event_type = event.get("type") or ""
    payload = event.get("data") or {}

    handlers = {
        "user.created": _upsert_user,
        "user.updated": _upsert_user,
        "user.deleted": _deactivate_user,
        "organization.created": _upsert_org,
        "organization.updated": _upsert_org,
        "organization.deleted": _archive_org,
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
        # Bust the per-user Clerk API cache so the next /auth/me hit
        # picks up the freshly-synced email/name/avatar without
        # waiting for the 5-minute TTL. Org / membership payloads
        # don't change user profile fields, so we only invalidate
        # on the user.* events.
        if event_type.startswith("user."):
            clerk_id = payload.get("id") if isinstance(payload, dict) else None
            if clerk_id:
                invalidate_user_cache(clerk_id)
    except WebhookNotReadyError:
        await _release_svix_id(svix_id)
        raise HTTPException(
            status_code=503,
            detail="Webhook dependencies not ready; please retry",
        ) from None
    except (ValueError, TypeError, KeyError) as exc:
        # Malformed Clerk payload / missing required fields — client error.
        # Keep the svix claim: retries with the same id would hit the same
        # bad payload.
        logger.warning(
            "Clerk webhook bad payload for %s: %s",
            event_type,
            redact_all(str(exc)),
        )
        from eden.api.utils.safe_error import safe_detail

        raise HTTPException(
            status_code=400,
            detail=safe_detail(exc, fallback="Invalid webhook payload"),
        ) from exc
    except Exception as exc:  # noqa: BLE001
        # True infra / DB failure — 503 so Clerk retries; release claim
        # so the redelivery is not treated as a duplicate.
        await _release_svix_id(svix_id)
        logger.exception(
            "Clerk webhook handler failed for %s: %s",
            event_type,
            redact_all(str(exc)),
        )
        from eden.api.utils.safe_error import safe_detail

        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Webhook handler unavailable"),
        ) from exc

    return {
        "status": "ok",
        "event_type": event_type,
        "received_at": datetime.now(UTC).isoformat() + "Z",
    }
