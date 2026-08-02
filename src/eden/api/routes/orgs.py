"""Organization management routes for Eden."""

import copy
import hashlib
import json
import logging
import re
import secrets
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field

from eden.api.deps import (
    _try_resolve_token_payload,
    eden_user_id_from_auth,
    get_current_org,
    get_current_user,
    get_eden_user_row_from_auth,
    invalidate_org_id_cache,
    log_audit_event,
    require_org_admin,
    require_org_member,
    require_org_owner,
    require_org_permission_dep,
    resolve_eden_org_id,
)
from eden.api.routes.billing import check_limit, sync_plan_usage
from eden.api.utils.org_schema import organizations_have_is_personal
from eden.api.utils.redact import redact_all
from eden.config import get_settings
from eden.services.invitation_service import (
    accept_invitation,
    create_invitation,
    decline_invitation,
    get_pending_invitations,
    resend_invitation,
    send_invite_email,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/orgs", tags=["organizations"])


def _parse_settings_dict(value: Any) -> dict:
    """Coerce org settings from DB (None / JSON str / dict) into a dict."""
    if value is None:
        return {}
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def _deep_merge_settings(base: dict, patch: dict) -> dict:
    """Deep-merge ``patch`` into ``base``.

    Nested dicts merge recursively; scalars overwrite; lists replace.
    """
    result = copy.deepcopy(base) if base else {}
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge_settings(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


class InviteMemberRequest(BaseModel):
    email: EmailStr
    role: str = Field(default="member", pattern="^(admin|member|viewer)$")


class UpdateMemberRoleRequest(BaseModel):
    role: str = Field(..., pattern="^(admin|member|viewer)$")


def slugify(name: str) -> str:
    """Convert org name to URL-safe slug."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:50]


def get_email_domain(email: str) -> str:
    """Extract the domain from an email address."""
    return email.split("@")[-1].lower() if "@" in email else ""


async def _assert_invitation_for_caller(
    *,
    org_id: str,
    invitation_id: str,
    user: dict,
) -> dict:
    """Load a pending invite and ensure it belongs to this path + caller.

    Accept/decline must not require pre-existing org membership (invitees
    are not members yet), but they MUST verify:
    1. Path ``org_id`` matches the invitation's org (no cross-tenant URL).
    2. Caller's Eden email matches the invitee email (no IDOR by UUID).
    """
    client = await get_postgres_client()
    invitation = await client.fetchrow(
        """
        SELECT id, org_id, email, status
        FROM org_invitations
        WHERE id = $1
        """,
        invitation_id,
    )
    if not invitation:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invitation not found",
        )

    path_org = await resolve_eden_org_id(org_id)
    invite_org = await resolve_eden_org_id(str(invitation["org_id"]))
    if not path_org or not invite_org or path_org != invite_org:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invitation not found for this organization",
        )

    eden_user = await get_eden_user_row_from_auth(user)
    if not eden_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is still provisioning. Please refresh.",
        )
    caller_email = (eden_user.get("email") or "").strip().lower()
    invite_email = (invitation.get("email") or "").strip().lower()
    if not caller_email or caller_email != invite_email:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invitation was not sent to this account",
        )
    return invitation


async def check_domain_restriction(client, org_id: str, email: str) -> tuple[bool, str | None]:
    """Check if email domain is allowed for the organization.

    Returns (is_allowed, error_message).
    """
    # Check if domain restriction is enforced
    row = await client.fetchrow(
        "SELECT domain_restriction_enforced FROM organizations WHERE id = $1",
        org_id,
    )
    if not row or not row["domain_restriction_enforced"]:
        return True, None

    # Get allowed domains for this org
    domain = get_email_domain(email)
    allowed = await client.fetchrow(
        "SELECT id FROM org_allowed_domains WHERE org_id = $1 AND LOWER(domain) = $2",
        org_id,
        domain,
    )
    if allowed:
        return True, None

    return (
        False,
        f"Email domain '{domain}' is not allowed for this organization. Only members with emails at allowed domains can be invited.",
    )


class CreateOrgRequest:
    """Request schema for org creation."""

    def __init__(self, name: str, make_default: bool = True):
        self.name = name
        self.make_default = make_default


class OrgResponse:
    """Response schema for org."""

    def __init__(self, id: str, name: str, slug: str, role: str, is_owner: bool, member_count: int):
        self.id = id
        self.name = name
        self.slug = slug
        self.role = role
        self.is_owner = is_owner
        self.member_count = member_count


class CreateOrgResponse:
    """Response for org creation."""

    def __init__(self, org_id: str, name: str, slug: str, role: str):
        self.org_id = org_id
        self.name = name
        self.slug = slug
        self.role = role


class CreateOrgBody(BaseModel):
    """JSON body for ``POST /orgs``.

    The portal's "Create workspace" recovery button
    (``lib/api/auth-api.ts``) posts ``{"name": ..., "make_default": ...}``
    as a JSON body with no query string. The handler previously declared
    ``name``/``make_default`` as bare scalars, which FastAPI binds as
    *query* params — so that button 422'd every time, and a user whose
    Clerk signup produced no organization had no way to get one.

    Both shapes are accepted now: body wins, query params are the
    fallback (that is what the existing integration tests send).
    """

    name: str = Field(min_length=2, max_length=100)
    make_default: bool = True


@router.post("", response_model=dict)
async def create_org(
    body: CreateOrgBody | None = None,
    name: str | None = Query(default=None),
    make_default: bool | None = Query(default=None),
    user: dict = Depends(get_current_user),
):
    """Create a new organization. Creator becomes owner.

    Backend-driven: we call Clerk Backend API first so the new Eden
    row's ``clerk_org_id`` is populated and the membership webhook
    will idempotently re-sync the ``org_members`` row from Clerk's
    side. We also insert the ``org_members`` row directly here so the
    user's first ``GET /auth/me`` roundtrip (which the onboarding
    wizard performs after the create call) sees the membership
    immediately, without waiting for webhook delivery.

    If Clerk is unreachable, we still create the Eden row, log a
    warning, and return it without ``clerk_org_id`` (response flag
    ``org_degraded: true``). The frontend's ``useOrg`` hook already
    handles this branch by falling through to the user's
    ``current_org_id``; an operator can re-sync later via a backfill
    script.
    """
    # Local imports keep the module-load cost cheap for tests that
    # never exercise Clerk.
    from eden.api.utils.clerk_client import (
        ClerkAPIError,
    )
    from eden.api.utils.clerk_client import (
        create_organization as clerk_create_org,
    )

    # Body wins over query; either shape is accepted (see CreateOrgBody).
    name = (body.name if body is not None else None) or name
    if make_default is None:
        make_default = body.make_default if body is not None else True

    client = await get_postgres_client()
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    # Validate name
    if not name or len(name) < 2 or len(name) > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Org name must be 2-100 characters",
        )

    # Idempotency guard. A double-submitted form, a retried request, or
    # a customer clicking "Create workspace" twice used to mint a second
    # identical org — and there is no UI for deleting one. One production
    # user accumulated seven orgs all named "Kaiav's Organization".
    #
    # Deliberately narrow: same owner, same name, recent, not archived.
    # A user who genuinely wants two identically-named orgs a minute
    # apart is not a real case; a duplicate submit is.
    recent_duplicate = await client.fetchrow(
        """
        SELECT id::text AS id, name, slug, clerk_org_id
        FROM organizations
        WHERE owner_id = $1::uuid
          AND lower(name) = lower($2)
          AND archived_at IS NULL
          AND created_at > NOW() - INTERVAL '60 seconds'
        ORDER BY created_at DESC
        LIMIT 1
        """,
        user_id,
        name,
    )
    if recent_duplicate:
        logger.info(
            "create_org: returning existing org %s for duplicate submit "
            "(owner=%s name=%r)",
            recent_duplicate["id"],
            user_id,
            name,
        )
        return {
            "org_id": recent_duplicate["id"],
            "name": recent_duplicate["name"],
            "slug": recent_duplicate["slug"],
            "role": "owner",
            "clerk_org_id": recent_duplicate["clerk_org_id"],
            "org_degraded": False,
            "is_personal": False,
        }

    slug = slugify(name)

    # Check slug uniqueness
    existing = await client.fetchrow(
        "SELECT id FROM organizations WHERE slug = $1",
        slug,
    )
    if existing:
        slug = f"{slug}-{uuid4().hex[:8]}"

    # Try Clerk first. On failure, log + continue with a backend-only
    # row. The user gets a working org either way; the degraded flag
    # surfaces a soft warning in the portal.
    clerk_org_id: str | None = None
    degraded = False
    try:
        clerk_org = await clerk_create_org(name=name, slug=slug)
        clerk_org_id = str(clerk_org.get("id") or "") or None
    except ClerkAPIError as exc:
        logger.warning(
            "Clerk org create failed for slug=%s: %s; continuing with backend-only org",
            slug,
            redact_all(str(exc)),
        )
        degraded = True
    except Exception as exc:  # noqa: BLE001 — defensive
        logger.exception(
            "Unexpected Clerk error on create_org slug=%s: %s", slug, redact_all(str(exc))
        )
        degraded = True

    # Create org (Eden row). We write the clerk_org_id we got from
    # Clerk; for webhook-created rows in the future, the
    # ``organization.created`` webhook will land at the
    # ``_upsert_org`` handler and backfill the same column.
    #
    # First/solo workspace: mark ``is_personal=true`` so settings can
    # soft-hide invite/SCIM/transfer for a single-developer org.
    # Subsequent orgs the same user creates stay team orgs (false).
    existing_memberships = await client.fetchval(
        "SELECT COUNT(*)::int FROM org_members WHERE user_id = $1",
        user_id,
    )
    is_personal = int(existing_memberships or 0) == 0
    personal_col = await organizations_have_is_personal(client)

    org_id = str(uuid4())
    try:
        if personal_col:
            query = """
                INSERT INTO organizations (
                    id, clerk_org_id, name, slug, owner_id, settings, is_personal
                )
                VALUES ($1, $2, $3, $4, $5, '{}', $6)
                RETURNING id
            """
            row = await client.fetchrow(
                query, org_id, clerk_org_id, name, slug, user_id, is_personal
            )
        else:
            query = """
                INSERT INTO organizations (id, clerk_org_id, name, slug, owner_id, settings)
                VALUES ($1, $2, $3, $4, $5, '{}')
                RETURNING id
            """
            row = await client.fetchrow(query, org_id, clerk_org_id, name, slug, user_id)
            is_personal = False
        # The caller almost always resolves this org id on the very next
        # request; a negative entry cached before this INSERT would 403
        # them off their own brand-new workspace.
        invalidate_org_id_cache(org_id, clerk_org_id)
    except Exception as exc:
        # If we created the Clerk org but failed to write the Eden
        # row, we have an orphan in Clerk. Log loudly so an operator
        # can run cleanup; don't auto-delete (Clerk charges per org
        # on some plans and auto-delete is riskier than the leak).
        msg = str(exc).lower()
        logger.exception(
            "Failed to write Eden org row after Clerk create " "(org_id=%s clerk_org_id=%s): %s",
            org_id,
            clerk_org_id,
            redact_all(str(exc)),
        )
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Organization already exists",
            ) from exc
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid user id",
            ) from exc
        if "foreign key" in msg:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to create organization",
        ) from exc
    if not row:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to create organization",
        )

    # Add creator as owner member. The Clerk
    # ``organizationMembership.created`` webhook will also write this
    # row idempotently (see ``clerk_webhooks.py:_upsert_membership``);
    # ``ON CONFLICT DO NOTHING`` keeps the local insert safe even if
    # the webhook lands first.
    #
    # ``last_writer_source = 'local'`` is critical: the webhook's
    # ``ON CONFLICT DO UPDATE`` (clerk_webhooks.py:393) only overwrites
    # the role when the existing row's ``last_writer_source`` is
    # also ``'clerk'``. Without this, the webhook fires ~1s later
    # with Clerk's ``org:admin`` role, ``clerk_role_to_eden_role``
    # maps it to ``admin``, and the creator's role silently gets
    # demoted from ``owner`` → ``admin`` — losing ``org:transfer``,
    # ``billing:edit``, ``gdpr:execute``, ``retention:override``.
    # June 2026 fix for solo devs being blocked from their own org.
    await client.execute(
        """
        INSERT INTO org_members (org_id, user_id, role, invited_by, last_writer_source)
        VALUES ($1, $2, 'owner', $2, 'local')
        ON CONFLICT (org_id, user_id) DO NOTHING
        """,
        org_id,
        user_id,
    )

    # Sync creator into Clerk org immediately so setActive / switcher work
    # without waiting on the membership webhook race.
    if clerk_org_id:
        try:
            from eden.api.utils.clerk_client import (
                ClerkAPIError,
            )
            from eden.api.utils.clerk_client import (
                create_membership as clerk_create_membership,
            )

            clerk_user_row = await client.fetchrow(
                "SELECT clerk_id FROM users WHERE id = $1",
                user_id,
            )
            clerk_user_id = (
                str(clerk_user_row["clerk_id"])
                if clerk_user_row and clerk_user_row.get("clerk_id")
                else None
            )
            if clerk_user_id:
                await clerk_create_membership(clerk_org_id, clerk_user_id, "owner")
        except ClerkAPIError as exc:
            logger.warning(
                "Clerk membership create for org creator failed org=%s: %s",
                org_id,
                redact_all(str(exc)),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Unexpected Clerk membership error for org creator org=%s: %s",
                org_id,
                redact_all(str(exc)),
            )

    # Free-only mode: every new org starts on ``org_free`` (3 seats,
    # ~400 credits ≈ $4/mo hard cap). ``ON CONFLICT DO NOTHING``
    # (no target) makes the inserts idempotent against the composite
    # UNIQUE constraints on both tables — re-runs after Clerk backfill
    # just skip silently.
    await client.execute(
        """
        INSERT INTO org_resource_limits (org_id, plan_name, effective_from)
        VALUES ($1, 'org_free', NOW())
        ON CONFLICT DO NOTHING
        """,
        org_id,
    )
    await client.execute(
        """
        INSERT INTO org_plans (
            org_id, plan_name,
            seats_limit, references_limit, jobs_limit,
            active
        )
        VALUES ($1, 'org_free', 3, 50, 40, true)
        ON CONFLICT DO NOTHING
        """,
        org_id,
    )

    # Update user's preferred_org if requested
    if make_default:
        await client.execute(
            "UPDATE users SET preferred_org_id = $1 WHERE id = $2",
            org_id,
            user_id,
        )

    # F35 — seed default signal library (best-effort; never block org create).
    try:
        from eden.signals.defaults import seed_org_signals

        await seed_org_signals(org_id, profile="advanced", created_by=user_id, pg=client)
    except Exception as exc:  # noqa: BLE001
        logger.info("F35 signal seed skipped for org=%s: %s", org_id, redact_all(str(exc)))

    # Phase 3 GA defaults — Artifacts + Ledger on for new orgs (also Settings default True).
    try:
        import json

        await client.execute(
            """
            UPDATE organizations
            SET features = COALESCE(features, '{}'::jsonb) || $2::jsonb
            WHERE id = $1
            """,
            org_id,
            json.dumps(
                {
                    "artifacts_v1": True,
                    "ledger_v1": True,
                    # Phase 8 / N23 — align with config.py GA defaults (agent ON).
                    "improvement_loop_preview": False,
                    "improvement_agent_v1": True,
                    "improvement_schedule_enabled": True,
                    "improvement_schedule_cron": "0 3 * * 0",
                    "evolution_loop_enabled": False,
                    "evolver_auto_canary_pct": 5,
                }
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("Phase3 feature seed skipped for org=%s: %s", org_id, redact_all(str(exc)))

    # N22 — seed org-default autonomy policy row (required before auto-execute).
    try:
        import json as _json

        from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy

        policy = AutonomousMaintenancePolicy(
            org_id=org_id,
            agent_id=None,
            maintenance_mode="assisted",
            auto_runtime_heal=True,
            auto_code_patch_pr=False,
            auto_code_patch_merge=False,
            auto_prompt_canary=True,
            auto_nudge_promote=False,
            auto_guardrail_promote=False,
            compliance_profile="standard",
        )
        existing_policy = await client.fetchrow(
            "SELECT id FROM autonomy_policies WHERE org_id = $1 AND agent_id IS NULL",
            org_id,
        )
        if existing_policy is None:
            await client.execute(
                """
                INSERT INTO autonomy_policies
                    (id, org_id, agent_id, policy, compliance_profile, updated_at)
                VALUES ($1::uuid, $2, NULL, $3::jsonb, $4, NOW())
                """,
                str(uuid4()),
                org_id,
                _json.dumps(policy.to_json()),
                policy.compliance_profile,
            )
    except Exception as exc:  # noqa: BLE001
        logger.info("N22 autonomy policy seed skipped for org=%s: %s", org_id, redact_all(str(exc)))

    return {
        "org_id": org_id,
        "name": name,
        "slug": slug,
        "role": "owner",
        "clerk_org_id": clerk_org_id,
        "org_degraded": degraded,
        "is_personal": bool(is_personal) if personal_col else False,
    }


@router.get("", response_model=list[dict])
async def list_user_orgs(
    user: dict = Depends(get_current_user),
    include_archived: bool = Query(default=False),
):
    """List all organizations the user is a member of (excludes archived by default)."""
    client = await get_postgres_client()
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        # A user whose Eden row has not landed yet is NOT a user with
        # zero organizations. Returning [] made the portal render the
        # "Create workspace" empty state, and a customer who clicks it
        # ends up with a second, duplicate org.
        #
        # 401 is what resolve_path_org_access already raises for this
        # exact condition (deps.py), and the portal maps it to the
        # re-auth / provisioning UX rather than the generic empty state.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is still provisioning. Please refresh.",
        )

    personal_col = await organizations_have_is_personal(client)
    personal_select = ", o.is_personal" if personal_col else ""
    personal_group = ", o.is_personal" if personal_col else ""

    if include_archived:
        query = f"""
            SELECT o.id, o.name, o.slug, o.owner_id, o.archived_at,
                   om.role,
                   COUNT(om2.id) as member_count
                   {personal_select}
            FROM organizations o
            JOIN org_members om ON om.org_id = o.id
            LEFT JOIN org_members om2 ON om2.org_id = o.id
            WHERE om.user_id = $1
            GROUP BY o.id, o.name, o.slug, o.owner_id, o.archived_at, om.role
                   {personal_group}
            ORDER BY o.created_at DESC
        """
        rows = await client.fetch(query, user_id)
    else:
        query = f"""
            SELECT o.id, o.name, o.slug, o.owner_id, o.archived_at,
                   om.role,
                   COUNT(om2.id) as member_count
                   {personal_select}
            FROM organizations o
            JOIN org_members om ON om.org_id = o.id
            LEFT JOIN org_members om2 ON om2.org_id = o.id
            WHERE om.user_id = $1 AND o.archived_at IS NULL
            GROUP BY o.id, o.name, o.slug, o.owner_id, o.archived_at, om.role
                   {personal_group}
            ORDER BY o.created_at DESC
        """
        rows = await client.fetch(query, user_id)

    out: list[dict] = []
    for r in rows:
        item = {
            "id": str(r["id"]),
            "name": r["name"],
            "slug": r["slug"],
            "role": r["role"],
            "is_owner": r["owner_id"] == user_id,
            "member_count": r["member_count"],
            "archived_at": r["archived_at"].isoformat() if r.get("archived_at") else None,
        }
        if personal_col:
            item["is_personal"] = bool(r["is_personal"])
        out.append(item)
    return out


@router.get("/{org_id}", response_model=dict)
async def get_org(org_id: str, user: dict = Depends(get_current_user)):
    """Get organization details (must be member)."""
    client = await get_postgres_client()
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )

    # Path may be a Clerk ``org_…`` id — rewrite before UUID-typed SQL
    # or asyncpg raises DataError → unhandled 500.
    eden_org_id = await resolve_eden_org_id(org_id)
    if not eden_org_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    # Verify membership
    membership = await client.fetchrow(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        eden_org_id,
        user_id,
    )
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )

    # Get org details
    org = await client.fetchrow(
        "SELECT id, name, slug, owner_id, settings, created_at FROM organizations WHERE id = $1",
        eden_org_id,
    )
    if not org:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    member_count = await client.fetchval(
        "SELECT COUNT(*) FROM org_members WHERE org_id = $1",
        eden_org_id,
    )

    return {
        "id": str(org["id"]),
        "name": org["name"],
        "slug": org["slug"],
        "role": membership["role"],
        "is_owner": org["owner_id"] == user_id,
        "member_count": member_count,
        "settings": org.get("settings", {}),
        "created_at": org["created_at"].isoformat() if org.get("created_at") else None,
    }


@router.post("/{org_id}/invites", response_model=dict)
async def send_invite(
    org_id: str,
    body: InviteMemberRequest,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("members:invite")),
):
    """Send an email invitation to a user to join the organization."""
    email = str(body.email).strip().lower()
    role = body.role
    # Permission dep already resolved Clerk path → Eden UUID.
    eden_org_id = org["org_id"]

    # Refresh seat usage before inviting.
    try:
        await sync_plan_usage(eden_org_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("sync_plan_usage before invite failed: %s", redact_all(str(exc)))

    # Check seat limit before inviting
    if await check_limit(eden_org_id, "seats"):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Seat limit reached. Upgrade your plan to add more members.",
        )

    client = await get_postgres_client()

    # Check domain restriction
    is_allowed, error_msg = await check_domain_restriction(client, eden_org_id, email)
    if not is_allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_msg,
        )

    # Check if user already a member
    existing_member = await client.fetchrow(
        "SELECT id FROM org_members WHERE org_id = $1 AND user_id = (SELECT id FROM users WHERE LOWER(email) = LOWER($2) LIMIT 1)",
        eden_org_id,
        email,
    )  # Audit 2026-06-22 B1.8 — case-insensitive email lookup
    if existing_member:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User is already a member of this organization",
        )

    # Create invitation (generates token)
    try:
        plain_token, invitation = await create_invitation(
            org_id=eden_org_id,
            email=email,
            role=role,
            invited_by=user["user_id"],
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e

    # Send invitation email (stub)
    email_result = await send_invite_email(
        to_email=email,
        org_name=invitation["org_name"],
        inviter_name=invitation["inviter_name"],
        role=role,
        token=plain_token,
        expires_at=invitation["expires_at"],
    )
    invite_url = f"{settings.portal_base_url}/invite/{plain_token}"

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user["user_id"],
        action="member.invited",
        target_type="user",
        target_id=invitation["id"],
        metadata={"invitee_email": email, "role": role},
    )

    return {
        "message": f"Invitation sent to {email}",
        "invitation_id": invitation["id"],
        "expires_at": invitation["expires_at"],
        "email_status": email_result.status,
        # Always return invite_url so admins can copy/share when email
        # is unconfigured or the invitee never received the message.
        "invite_url": invite_url,
    }


@router.get("/{org_id}/invites", response_model=list[dict])
async def list_invitations(
    org_id: str,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("members:invite")),
):
    """List all pending invitations for an organization."""
    _ = org_id, user
    invitations = await get_pending_invitations(org["org_id"])
    return invitations


@router.post("/{org_id}/invites/{invitation_id}/resend", response_model=dict)
async def resend_org_invitation(
    org_id: str,
    invitation_id: str,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("members:invite")),
):
    """Resend a pending invitation (rotates token, extends expiry).

    The portal's "Resend invite" button used to re-POST ``/invites``,
    which ``create_invitation`` rejects with "already pending" — so the
    button failed for exactly the invites it exists for.
    """
    eden_org_id = org["org_id"]
    try:
        plain_token, invitation = await resend_invitation(invitation_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e

    if str(invitation["org_id"]) != str(eden_org_id):
        # Cross-tenant guard — same 404 shape as the accept path.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invitation not found for this organization",
        )

    email_result = await send_invite_email(
        to_email=invitation["email"],
        org_name=invitation["org_name"],
        inviter_name=invitation["inviter_name"],
        role=invitation["role"],
        token=plain_token,
        expires_at=invitation["expires_at"],
    )
    invite_url = f"{settings.portal_base_url}/invite/{plain_token}"

    client = await get_postgres_client()
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user["user_id"],
        action="member.invite_resent",
        target_type="user",
        target_id=invitation["id"],
        metadata={"invitee_email": invitation["email"], "role": invitation["role"]},
    )

    return {
        "message": f"Invitation resent to {invitation['email']}",
        "invitation_id": invitation["id"],
        "expires_at": invitation["expires_at"],
        "email_status": email_result.status,
        "invite_url": invite_url,
    }


@router.post("/{org_id}/invites/{invitation_id}/accept", response_model=dict)
async def accept_org_invitation(
    org_id: str,
    invitation_id: str,
    user: dict = Depends(get_current_user),
):
    """Accept an organization invitation.

    The point of this call is to *create* a membership, so we do not
    require pre-existing ``org_members`` membership (that would 403
    for any first-time invitee). The ``accept_invitation`` service
    re-queries the invite, validates status + expiry, and inserts
    the row idempotently.
    """
    await _assert_invitation_for_caller(org_id=org_id, invitation_id=invitation_id, user=user)

    try:
        result = await accept_invitation(invitation_id, user["user_id"])
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e

    # Audit log
    client = await get_postgres_client()
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="member.joined",
        target_type="user",
        target_id=user["user_id"],
        metadata={"role": result["role"]},
    )

    return {
        "message": "Invitation accepted",
        "org_id": result["org_id"],
        "role": result["role"],
        # ``clerk_org_id`` is forwarded from the service; lets the
        # portal ``setActive({ organization: ... })`` without a second
        # Clerk lookup.
        "clerk_org_id": result.get("clerk_org_id"),
    }


@router.post("/{org_id}/invites/{invitation_id}/decline", response_model=dict)
async def decline_org_invitation(
    org_id: str,
    invitation_id: str,
    user: dict = Depends(get_current_user),
):
    """Decline an organization invitation.

    Mirror accept: invitees are not members yet, so do NOT
    ``require_org_member``. Verify path org + invitee email instead.
    """
    await _assert_invitation_for_caller(org_id=org_id, invitation_id=invitation_id, user=user)

    try:
        await decline_invitation(invitation_id, user["user_id"])
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e

    # Audit log
    client = await get_postgres_client()
    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=user["user_id"],
        action="invitation.declined",
        target_type="invitation",
        target_id=invitation_id,
        metadata={},
    )

    return {"message": "Invitation declined"}


@router.delete("/{org_id}/members/{user_id}", response_model=dict)
async def remove_member(
    org_id: str,
    user_id: str,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("members:remove")),
):
    """Remove a member from the organization."""
    eden_org_id = org["org_id"]
    _ = org_id

    client = await get_postgres_client()

    # Can't remove owner
    org_data = await client.fetchrow(
        "SELECT owner_id FROM organizations WHERE id = $1", eden_org_id
    )
    if org_data and str(org_data["owner_id"]) == user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove the organization owner",
        )

    # Can't remove self if not admin
    om = await client.fetchrow(
        "SELECT role FROM org_members WHERE user_id = $1 AND org_id = $2",
        user["user_id"],
        eden_org_id,
    )
    if user_id == user["user_id"] and (not om or om["role"] != "owner"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Admins cannot remove themselves",
        )

    await client.execute(
        "DELETE FROM org_members WHERE org_id = $1 AND user_id = $2",
        eden_org_id,
        user_id,
    )

    # Best-effort Clerk membership delete so the switcher stays in sync.
    try:
        from eden.api.utils.clerk_client import (
            delete_membership,
            resolve_clerk_org_id,
        )

        clerk_org_id = await resolve_clerk_org_id(client, eden_org_id)
        member_row = await client.fetchrow(
            "SELECT clerk_id FROM users WHERE id = $1",
            user_id,
        )
        clerk_user_id = (
            str(member_row["clerk_id"]) if member_row and member_row.get("clerk_id") else None
        )
        if clerk_org_id and clerk_user_id:
            await delete_membership(clerk_org_id, clerk_user_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Clerk membership delete failed org=%s user=%s: %s",
            eden_org_id,
            user_id,
            redact_all(str(exc)),
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user["user_id"],
        action="member.removed",
        target_type="user",
        target_id=user_id,
        metadata={},
    )

    return {"message": "Member removed"}


@router.patch("/{org_id}/members/{user_id}", response_model=dict)
async def update_member_role(
    org_id: str,
    user_id: str,
    body: UpdateMemberRoleRequest,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("members:invite")),
):
    """Update a member's role (admin/member/viewer). Owner cannot be demoted here."""
    eden_org_id = org["org_id"]
    _ = org_id
    client = await get_postgres_client()
    org_data = await client.fetchrow(
        "SELECT owner_id FROM organizations WHERE id = $1", eden_org_id
    )
    if org_data and str(org_data["owner_id"]) == user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot change the organization owner's role; transfer ownership instead",
        )
    row = await client.fetchrow(
        """
        UPDATE org_members
        SET role = $3, last_writer_source = 'local'
        WHERE org_id = $1 AND user_id = $2
        RETURNING user_id
        """,
        eden_org_id,
        user_id,
        body.role,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Member not found")

    try:
        from eden.api.utils.clerk_client import (
            resolve_clerk_org_id,
            update_membership,
        )

        clerk_org_id = await resolve_clerk_org_id(client, eden_org_id)
        member_row = await client.fetchrow(
            "SELECT clerk_id FROM users WHERE id = $1",
            user_id,
        )
        clerk_user_id = (
            str(member_row["clerk_id"]) if member_row and member_row.get("clerk_id") else None
        )
        if clerk_org_id and clerk_user_id:
            await update_membership(clerk_org_id, clerk_user_id, body.role)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Clerk role sync failed org=%s user=%s: %s",
            eden_org_id,
            user_id,
            redact_all(str(exc)),
        )

    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user["user_id"],
        action="member.role_updated",
        target_type="user",
        target_id=user_id,
        metadata={"role": body.role},
    )
    return {"message": "Role updated", "user_id": user_id, "role": body.role}


@router.get("/{org_id}/members", response_model=list[dict])
async def list_org_members(
    org_id: str,
    user: dict = Depends(get_current_user),
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    payload: dict | None = Depends(_try_resolve_token_payload),
    limit: int = Query(default=500, ge=1, le=2000),
):
    """List members of an organization (bounded).

    ``limit`` caps the result set so a large tenant cannot dump an
    unbounded JOIN of ``org_members`` × ``users`` on every settings
    load. Default 500 covers typical orgs; raise via query param up
    to 2000 when an admin UI needs a fuller roster.
    """
    eden_org_id = await resolve_eden_org_id(org_id or x_org_id)
    if not eden_org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )
    org = await get_current_org(eden_org_id, payload)
    if not org:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )

    client = await get_postgres_client()

    query = """
        SELECT om.user_id, om.role, om.joined_at, om.last_active_at,
               u.email, u.name, COALESCE(u.two_factor_enabled, FALSE) AS two_factor_enabled
        FROM org_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1
        ORDER BY om.joined_at ASC
        LIMIT $2
    """
    rows = await client.fetch(query, eden_org_id, limit)

    return [
        {
            "user_id": str(r["user_id"]),
            "email": r["email"],
            "name": r["name"],
            "role": r["role"],
            # Portal MemberCard.status — members from org_members are active.
            "status": "active",
            "joined_at": r["joined_at"].isoformat() if r.get("joined_at") else None,
            "last_active_at": r["last_active_at"].isoformat() if r.get("last_active_at") else None,
            # P11: surface 2FA status so org admins can see who's
            # protected when the org has ``two_factor_enforced`` set.
            "two_factor_enabled": bool(r.get("two_factor_enabled")),
        }
        for r in rows
    ]


@router.patch("/{org_id}/settings", response_model=dict)
async def update_org_settings(
    org_id: str,
    settings: dict,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("settings:edit")),
):
    """Update organization settings (admin only).

    Deep-merges the request patch into existing settings so nested
    siblings are preserved (scalars overwrite; lists replace).
    """
    eden_org_id = org["org_id"]
    _ = org_id

    client = await get_postgres_client()

    # Get old settings for audit / merge base
    raw_old = await client.fetchval(
        "SELECT settings FROM organizations WHERE id = $1",
        eden_org_id,
    )
    old_settings = _parse_settings_dict(raw_old)
    patch = dict(settings or {})
    # Identity rename is a column on organizations — not settings JSON.
    # Portal Settings "Rename workspace" sends ``{ "name": "..." }``.
    rename: str | None = None
    if "name" in patch:
        raw_name = patch.pop("name")
        if isinstance(raw_name, str):
            cleaned = raw_name.strip()
            if cleaned:
                rename = cleaned[:256]

    merged = _deep_merge_settings(old_settings, patch)

    if rename is not None:
        await client.execute(
            "UPDATE organizations SET name = $1, settings = $2 WHERE id = $3",
            rename,
            merged,
            eden_org_id,
        )
    else:
        await client.execute(
            "UPDATE organizations SET settings = $1 WHERE id = $2",
            merged,
            eden_org_id,
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user["user_id"],
        action="settings.updated",
        target_type="settings",
        target_id=eden_org_id,
        metadata={
            "old_settings": old_settings,
            "new_settings": merged,
            **({"renamed_to": rename} if rename is not None else {}),
        },
    )

    out: dict = {"message": "Settings updated", "settings": merged}
    if rename is not None:
        out["name"] = rename
    return out


@router.post("/{org_id}/archive", response_model=dict)
async def archive_org(
    org_id: str,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("settings:edit")),
):
    """Archive an organization (soft-delete). Admin or owner only."""
    eden_org_id = org["org_id"]
    _ = org_id

    client = await get_postgres_client()

    # Check if already archived
    org_row = await client.fetchrow(
        "SELECT archived_at FROM organizations WHERE id = $1",
        eden_org_id,
    )
    if not org_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )
    if org_row.get("archived_at"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Organization is already archived",
        )

    await client.execute(
        "UPDATE organizations SET archived_at = NOW() WHERE id = $1",
        eden_org_id,
    )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user["user_id"],
        action="org.archived",
        target_type="organization",
        target_id=eden_org_id,
        metadata={},
    )

    return {"message": "Organization archived", "org_id": eden_org_id}


@router.delete("/{org_id}", response_model=dict)
async def delete_org(
    org_id: str,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Permanently delete an organization. Owner only. Warning: cascades to all org data."""
    # Pass path org_id + resolved JWT — bare ``await require_org_owner(org_id)``
    # leaves ``payload`` as an unresolved Depends sentinel → always 403.
    # Use Eden UUID from ownership gate — raw Clerk path ids are not
    # organizations.id / skills.org_id values.
    org = await require_org_owner(org_id, payload)
    eden_org_id = org["org_id"]
    _ = org_id, user

    client = await get_postgres_client()

    # Check for existing data (jobs feature removed June 2026)
    skill_count = await client.fetchval(
        "SELECT COUNT(*) FROM skills WHERE org_id = $1",
        eden_org_id,
    )
    ref_count = await client.fetchval(
        "SELECT COUNT(*) FROM code_references WHERE org_id = $1",
        eden_org_id,
    )

    total_data = (skill_count or 0) + (ref_count or 0)
    if total_data > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot delete org with existing data: {skill_count} skills, {ref_count} code references. Remove all data first.",
        )

    # Verify no archived_at (must be actively deleted)
    org_row = await client.fetchrow(
        "SELECT id FROM organizations WHERE id = $1 AND archived_at IS NOT NULL",
        eden_org_id,
    )
    if not org_row:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Organization must be archived before permanent deletion. Archive first, then delete.",
        )

    # Delete org (cascade should handle org_members and other CASCADE references)
    await client.execute(
        "DELETE FROM organizations WHERE id = $1",
        eden_org_id,
    )

    return {"message": "Organization permanently deleted", "org_id": eden_org_id}


@router.post("/{org_id}/transfer-ownership", response_model=dict)
async def transfer_ownership(
    org_id: str,
    target_user_id: str,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("org:transfer")),
):
    """Transfer organization ownership to another member.

    The current owner becomes an admin after the transfer.
    """
    eden_org_id = org["org_id"]
    _ = org_id

    client = await get_postgres_client()
    current_user_id = user["user_id"]

    # Verify target user is a member
    target_member = await client.fetchrow(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        eden_org_id,
        target_user_id,
    )
    if not target_member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Target user is not a member of this organization",
        )

    # Cannot transfer to self
    if target_user_id == current_user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot transfer ownership to yourself",
        )

    # Atomic transaction: update owner and roles
    # Audit 2026-06-22 B1.30 — set new owner in org_members FIRST so a
    # crash mid-transaction doesn't leave organizations.owner_id
    # pointing at a user who isn't owner in org_members.
    async with client.transaction():
        # Verify target is still a member (race-safe via WHERE clause).
        result = await client.execute(
            "UPDATE org_members SET role = 'owner' WHERE org_id = $1 AND user_id = $2",
            eden_org_id,
            target_user_id,
        )
        if result.endswith(" 0"):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Target user is no longer a member of this organization",
            )
        # Demote old owner
        await client.execute(
            "UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2",
            eden_org_id,
            current_user_id,
        )
        # Finally update organizations.owner_id
        await client.execute(
            "UPDATE organizations SET owner_id = $1 WHERE id = $2",
            target_user_id,
            eden_org_id,
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=current_user_id,
        action="ownership.transferred",
        target_type="user",
        target_id=target_user_id,
        metadata={"previous_owner_id": current_user_id, "new_owner_id": target_user_id},
    )

    return {"message": "Ownership transferred successfully"}


# ============================================================================
# SCIM Configuration (admin-only)
# ============================================================================


@router.get("/{org_id}/scim/config", response_model=dict)
async def get_scim_config(
    org_id: str,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Get SCIM configuration for the organization (admin only).

    Returns config including whether SCIM is enabled, last sync, etc.
    Does NOT return the raw token (it's hashed).
    """
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]
    _ = user

    client = await get_postgres_client()

    row = await client.fetchrow(
        "SELECT scim_enabled, last_sync_at, provisioned_user_count, created_at, updated_at FROM org_scim_config WHERE org_id = $1",
        eden_org_id,
    )

    if not row:
        return {
            "scim_enabled": False,
            "last_sync_at": None,
            "provisioned_user_count": 0,
            "has_token": False,
        }

    return {
        "scim_enabled": row["scim_enabled"],
        "last_sync_at": row["last_sync_at"].isoformat() if row.get("last_sync_at") else None,
        "provisioned_user_count": row["provisioned_user_count"] or 0,
        "has_token": bool(row["scim_enabled"]),  # Token exists if SCIM is enabled
    }


@router.post("/{org_id}/scim/config", response_model=dict)
async def configure_scim(
    org_id: str,
    enabled: bool,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Enable or disable SCIM for the organization (admin only).

    When enabling, generates a new bearer token.
    """
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]

    client = await get_postgres_client()

    # Check if config exists
    existing = await client.fetchrow(
        "SELECT id, scim_token_hash FROM org_scim_config WHERE org_id = $1",
        eden_org_id,
    )

    if enabled:
        # Generate new token
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()

        if existing:
            await client.execute(
                """
                UPDATE org_scim_config
                SET scim_enabled = TRUE, scim_token_hash = $1, updated_at = NOW()
                WHERE org_id = $2
                """,
                token_hash,
                eden_org_id,
            )
        else:
            await client.execute(
                """
                INSERT INTO org_scim_config (org_id, scim_enabled, scim_token_hash)
                VALUES ($1, TRUE, $2)
                """,
                eden_org_id,
                token_hash,
            )

        # Audit log
        await log_audit_event(
            client=client,
            org_id=eden_org_id,
            user_id=user["user_id"],
            action="scim.enabled",
            target_type="scim_config",
            target_id=eden_org_id,
            metadata={},
        )

        return {
            "scim_enabled": True,
            "bearer_token": raw_token,  # Only returned once on creation!
            "message": "Store this token securely. It will not be shown again.",
        }
    else:
        # Disable SCIM
        if existing:
            await client.execute(
                """
                UPDATE org_scim_config
                SET scim_enabled = FALSE, scim_token_hash = NULL, updated_at = NOW()
                WHERE org_id = $1
                """,
                eden_org_id,
            )
        else:
            await client.execute(
                """
                INSERT INTO org_scim_config (org_id, scim_enabled)
                VALUES ($1, FALSE)
                """,
                eden_org_id,
            )

        # Audit log
        await log_audit_event(
            client=client,
            org_id=eden_org_id,
            user_id=user["user_id"],
            action="scim.disabled",
            target_type="scim_config",
            target_id=eden_org_id,
            metadata={},
        )

        return {
            "scim_enabled": False,
            "message": "SCIM has been disabled.",
        }


@router.post("/{org_id}/scim/rotate-token", response_model=dict)
async def rotate_scim_token(
    org_id: str,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Rotate the SCIM bearer token (admin only).

    Invalidates the old token and generates a new one.
    """
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]

    client = await get_postgres_client()

    # Generate new token
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()

    # Update or create config
    existing = await client.fetchrow(
        "SELECT id FROM org_scim_config WHERE org_id = $1",
        eden_org_id,
    )

    if existing:
        await client.execute(
            """
            UPDATE org_scim_config
            SET scim_enabled = TRUE, scim_token_hash = $1, updated_at = NOW()
            WHERE org_id = $2
            """,
            token_hash,
            eden_org_id,
        )
    else:
        await client.execute(
            """
            INSERT INTO org_scim_config (org_id, scim_enabled, scim_token_hash)
            VALUES ($1, TRUE, $2)
            """,
            eden_org_id,
            token_hash,
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user["user_id"],
        action="scim.token_rotated",
        target_type="scim_config",
        target_id=eden_org_id,
        metadata={},
    )

    return {
        "bearer_token": raw_token,
        "message": "Token rotated. Store this new token securely. It will not be shown again.",
    }


# ============================================================================
# Import hashlib for token hashing
# ============================================================================
# DOMAIN RESTRICTION MANAGEMENT
# ============================================================================


class DomainRestrictionSettings(BaseModel):
    """Request schema for updating domain restriction settings."""

    domain_restriction_enforced: bool


class AddAllowedDomainRequest(BaseModel):
    """Request schema for adding an allowed domain."""

    domain: str


@router.get("/{org_id}/allowed-domains", response_model=list[dict])
async def list_allowed_domains(
    org_id: str,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """List all allowed email domains for an organization."""
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]

    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT id, domain, added_by, created_at
        FROM org_allowed_domains
        WHERE org_id = $1
        ORDER BY domain ASC
        """,
        eden_org_id,
    )

    return [
        {
            "id": str(r["id"]),
            "domain": r["domain"],
            "added_by": str(r["added_by"]),
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in rows
    ]


@router.post("/{org_id}/allowed-domains", response_model=dict)
async def add_allowed_domain(
    org_id: str,
    request: AddAllowedDomainRequest,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Add an allowed email domain to an organization."""
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]

    domain = request.domain.lower().strip()
    if not domain:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Domain cannot be empty",
        )

    # Basic domain validation
    if not re.match(r"^[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,}$", domain):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid domain format",
        )

    client = await get_postgres_client()
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    try:
        row = await client.fetchrow(
            """
            INSERT INTO org_allowed_domains (org_id, domain, added_by)
            VALUES ($1, $2, $3)
            RETURNING id, created_at
            """,
            eden_org_id,
            domain,
            user_id,
        )
    except Exception as e:
        msg = str(e).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Domain is already in the allowed list",
            ) from e
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid organization id",
            ) from e
        if "foreign key" in msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid organization or user for domain allowlist",
            ) from e
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to add domain",
        ) from e

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Domain is already in the allowed list",
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user_id,
        action="domain.added",
        target_type="domain",
        target_id=row["id"],
        metadata={"domain": domain},
    )

    return {
        "id": str(row["id"]),
        "domain": domain,
        "added_by": user_id,
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
    }


@router.delete("/{org_id}/allowed-domains/{domain_id}", response_model=dict)
async def remove_allowed_domain(
    org_id: str,
    domain_id: str,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Remove an allowed email domain from an organization."""
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]
    user_id = await eden_user_id_from_auth(user)

    client = await get_postgres_client()

    result = await client.execute(
        "DELETE FROM org_allowed_domains WHERE id = $1 AND org_id = $2",
        domain_id,
        eden_org_id,
    )
    if result == "DELETE 0":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Domain not found in allowed list",
        )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user_id or user.get("user_id"),
        action="domain.removed",
        target_type="domain",
        target_id=domain_id,
        metadata={},
    )

    return {"message": "Domain removed from allowed list"}


@router.get("/{org_id}/domain-restriction", response_model=dict)
async def get_domain_restriction_settings(
    org_id: str,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Get domain restriction settings for an organization."""
    # ``authorization=None`` was a TypeError → 500; pass resolved JWT.
    # Use Eden UUID from membership gate — raw Clerk path ids are not
    # organizations.id values (same rewrite as allowed-domains).
    org = await require_org_member(org_id, payload)
    eden_org_id = org["org_id"]
    _ = user

    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT domain_restriction_enforced FROM organizations WHERE id = $1",
        eden_org_id,
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    return {
        "domain_restriction_enforced": row["domain_restriction_enforced"],
    }


@router.patch("/{org_id}/domain-restriction", response_model=dict)
async def update_domain_restriction_settings(
    org_id: str,
    request: DomainRestrictionSettings,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Update domain restriction enforcement for an organization."""
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]

    client = await get_postgres_client()

    await client.execute(
        "UPDATE organizations SET domain_restriction_enforced = $1 WHERE id = $2",
        request.domain_restriction_enforced,
        eden_org_id,
    )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user["user_id"],
        action="domain_restriction.updated",
        target_type="settings",
        target_id=eden_org_id,
        metadata={"domain_restriction_enforced": request.domain_restriction_enforced},
    )

    return {
        "domain_restriction_enforced": request.domain_restriction_enforced,
    }


# ============================================================================
# 2FA ENFORCEMENT MANAGEMENT
# ============================================================================


class EnforceTwoFARequest(BaseModel):
    """Request schema for 2FA enforcement toggle."""

    enforce: bool


@router.post("/{org_id}/2fa/enforce", response_model=dict)
async def enforce_org_2fa(
    org_id: str,
    request: EnforceTwoFARequest,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Enable or disable 2FA enforcement for the organization.

    Only org admins/owners can toggle this setting.
    When enabled, all org members must have 2FA enabled to access the org.
    """
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]

    client = await get_postgres_client()

    # Update the two_factor_enforced flag
    await client.execute(
        "UPDATE organizations SET two_factor_enforced = $1 WHERE id = $2",
        request.enforce,
        eden_org_id,
    )

    # Audit log
    await log_audit_event(
        client=client,
        org_id=eden_org_id,
        user_id=user["user_id"],
        action="2fa_enforcement.updated",
        target_type="settings",
        target_id=eden_org_id,
        metadata={"two_factor_enforced": request.enforce},
    )

    action = "enabled" if request.enforce else "disabled"
    return {
        "two_factor_enforced": request.enforce,
        "message": f"2FA enforcement has been {action} for this organization",
    }


@router.get("/{org_id}/2fa/enforcement-status", response_model=dict)
async def get_2fa_enforcement_status(
    org_id: str,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Get 2FA enforcement status for an organization."""
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]

    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT two_factor_enforced FROM organizations WHERE id = $1",
        eden_org_id,
    )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    return {
        "two_factor_enforced": row["two_factor_enforced"],
    }


@router.get("/{org_id}/members-2fa-status", response_model=list[dict])
async def get_org_members_2fa_status(
    org_id: str,
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
):
    """Get 2FA status for all members in an organization.

    Only org admins/owners can view this.
    """
    org = await require_org_admin(org_id, payload)
    eden_org_id = org["org_id"]

    client = await get_postgres_client()

    query = """
        SELECT u.id, u.email, u.name, u.two_factor_enabled, om.joined_at, om.last_active_at
        FROM org_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1
        ORDER BY om.joined_at DESC
    """
    rows = await client.fetch(query, eden_org_id)

    return [
        {
            "user_id": str(row["id"]),
            "email": row["email"],
            "name": row["name"],
            "two_factor_enabled": row["two_factor_enabled"],
            "joined_at": row["joined_at"].isoformat() if row["joined_at"] else None,
            "last_active_at": row["last_active_at"].isoformat() if row["last_active_at"] else None,
        }
        for row in rows
    ]
