"""Billing and subscription management routes for Eden.

Handles plan reads (with cost-based usage surface) and Stripe-backed
subscribe / cancel / webhook endpoints (kept dormant in free-only mode).

**Free-only mode (June 2026).** All Stripe-backed endpoints return
``503`` until paid plans ship. The ``/plans`` endpoint surfaces the org's
running USD cost against its tier cap (the primary free-tier lever).
"""

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from eden.api.deps import (
    get_current_user,
    get_postgres_client,
    require_org_permission,  # noqa: F401  (monkeypatched by tests/api/test_billing_routes.py)
    require_org_permission_dep,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import safe_detail
from eden.config import get_settings
from eden.services.plan_tiers import get_plan_tier
from eden.services.usage_service import UsageService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/billing", tags=["billing"], dependencies=[Depends(require_path_org_access)])

# Public Stripe webhook — signature verification only (no JWT / org path auth).
# Mounted at ``POST /webhooks/stripe`` so Stripe can reach it; the org-scoped
# ``/orgs/{org_id}/billing/webhook`` path is deprecated.
webhook_router = APIRouter(prefix="/webhooks", tags=["billing-webhooks"])

_T = TypeVar("_T")


async def _stripe_call[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run a sync Stripe SDK call off the event loop (K16 / A4)."""
    return await asyncio.to_thread(fn, *args, **kwargs)


def _is_stripe_client_error(exc: BaseException) -> bool:
    """True when Stripe rejected the call as a client/4xx error.

    Maps ``InvalidRequestError`` (and siblings with ``http_status`` in
    400–499) to HTTP 400 instead of leaking them through a bare
    ``except Exception → 500``.
    """
    name = type(exc).__name__
    if name in ("InvalidRequestError", "CardError", "AuthenticationError"):
        return True
    http_status = getattr(exc, "http_status", None)
    return isinstance(http_status, int) and 400 <= http_status < 500

# Ponytail: paid plans are off. The Stripe-backed routes below return
# 503 until this flips. The constants they reference (PLAN_DEFINITIONS,
# handle_subscription_event) are preserved so the surface can come
# back online by setting this flag + wiring Stripe keys.
PAID_PLANS_ENABLED = False


# ============================================================================
# Pydantic Models
# ============================================================================

class PlanLimits(BaseModel):
    """Plan limit + current usage information returned to the portal.

    The portal leads with ``credits_used`` / ``credits_hard_limit`` as
    the primary free-tier meter (100 credits ≈ $1). USD fields remain
    as mirrors for FinOps. Token / storage / sandbox counts are
    informational. Seat / reference counts still gate invite / create
    flows via the org_plans rows.
    """
    plan_name: str
    display_name: str
    # PRIMARY cap — credits this period (100 credits = $1 Eden COGS)
    credits_used: float = 0.0
    credits_soft_limit: float = 0.0
    credits_hard_limit: float = 0.0
    credits_status: str = "ok"  # 'ok' | 'soft_exceeded' | 'hard_exceeded'
    # USD mirrors
    cost_used_usd: float
    cost_soft_limit_usd: float
    cost_hard_limit_usd: float
    cost_status: str   # 'ok' | 'soft_exceeded' | 'hard_exceeded'
    # Resource counts (informational)
    seats_limit: int
    seats_used: int
    references_limit: int
    references_used: int
    tokens_used: int
    storage_mb_used: float
    sandbox_seconds_used: float
    active: bool
    stripe_subscription_id: str | None = None
    subscription_status: str | None = None
    current_period_end: str | None = None


class SubscribeRequest(BaseModel):
    """Request to subscribe to a plan."""
    plan_name: str  # 'starter', 'pro', 'enterprise'
    success_url: str
    cancel_url: str


class InvoiceResponse(BaseModel):
    """Invoice information from Stripe."""
    id: str
    amount_paid: int  # in cents
    currency: str
    status: str
    created: int  # Unix timestamp
    invoice_url: str | None = None


# ============================================================================
# Plan Definition (simplified - in production, use Stripe prices)
# ============================================================================

PLAN_DEFINITIONS = {
    "starter": {
        "seats_limit": 5,
        "references_limit": 50,
        "price_monthly": 29,
    },
    "pro": {
        "seats_limit": 15,
        "references_limit": 200,
        "price_monthly": 79,
    },
    "enterprise": {
        "seats_limit": 50,
        "references_limit": 1000,
        "price_monthly": 199,
    },
}


# ============================================================================
# Helper Functions
# ============================================================================

def _get_settings_data(settings: any) -> dict:
    """Parse org settings from DB, handling both JSON and JSONB types."""
    if isinstance(settings, dict):
        return settings
    if isinstance(settings, str):
        import json
        try:
            return json.loads(settings)
        except Exception:
            return {}
    return {}


async def get_org_plan(org_id: str) -> dict | None:
    """Get the active plan for an organization."""
    client = await get_postgres_client()
    query = """
        SELECT op.*, ss.status as subscription_status, ss.current_period_end
        FROM org_plans op
        LEFT JOIN stripe_subscriptions ss ON ss.stripe_subscription_id = op.stripe_subscription_id
        WHERE op.org_id = $1 AND op.active = true
    """
    return await client.fetchrow(query, org_id)


async def sync_plan_usage(org_id: str) -> None:
    """Sync plan usage with actual counts."""
    client = await get_postgres_client()

    # Single query for all usage counts
    query = """
        SELECT
            (SELECT COUNT(*) FROM org_members WHERE org_id = $1) as seats_used,
            (SELECT COUNT(*) FROM code_references WHERE org_id = $1) as references_used
    """
    row = await client.fetchrow(query, org_id)

    if row:
        await client.execute(
            """
            UPDATE org_plans
            SET seats_used = $1, references_used = $2, updated_at = NOW()
            WHERE org_id = $3 AND active = true
            """,
            row["seats_used"],
            row["references_used"],
            org_id,
        )


async def create_or_update_plan(org_id: str, plan_name: str) -> None:
    """Create or update a plan for an organization."""
    client = await get_postgres_client()
    plan_def = PLAN_DEFINITIONS.get(plan_name)

    if not plan_def:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown plan: {plan_name}",
        )

    # Check if plan exists
    existing = await client.fetchrow(
        "SELECT id FROM org_plans WHERE org_id = $1 AND active = true",
        org_id,
    )

    if existing:
        # Update existing plan
        await client.execute(
            """
            UPDATE org_plans
            SET plan_name = $1, seats_limit = $2, references_limit = $3, updated_at = NOW()
            WHERE org_id = $4 AND active = true
            """,
            plan_name,
            plan_def["seats_limit"],
            plan_def["references_limit"],
            org_id,
        )
    else:
        # Create new plan
        await client.execute(
            """
            INSERT INTO org_plans (org_id, plan_name, seats_limit, references_limit, seats_used, references_used)
            VALUES ($1, $2, $3, $4, 0, 0)
            """,
            org_id,
            plan_name,
            plan_def["seats_limit"],
            plan_def["references_limit"],
        )


async def check_limit(
    org_id: str,
    limit_type: str,  # 'seats' or 'references'
) -> bool:
    """Check if org is at or over a limit. Returns True if limit exceeded."""
    plan = await get_org_plan(org_id)
    if not plan:
        # No plan row = treat as org_free defaults (backfill in flight or
        # never-queried org). Use the tier definition rather than 0/0.
        tier = get_plan_tier("org_free")
        if limit_type == "seats":
            return tier.seats_limit <= 0  # always False at zero
        if limit_type == "references":
            return tier.references_limit <= 0
        return False

    if limit_type == "seats":
        return plan["seats_used"] >= plan["seats_limit"]
    elif limit_type == "references":
        return plan["references_used"] >= plan["references_limit"]

    return False


def _require_paid_plans_enabled() -> None:
    """Gate paid-plan endpoints. Raises 503 until :data:`PAID_PLANS_ENABLED`
    flips to True (and Stripe keys are wired).
    """
    if not PAID_PLANS_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Paid plans are not available yet. Eden is currently free-only.",
        )


# ============================================================================
# Routes
# ============================================================================

@router.get("/plans", response_model=PlanLimits)
async def get_plans(org_id: str = Depends(require_path_org_access), user: dict = Depends(get_current_user),
        _check_billing_view: dict = Depends(require_org_permission_dep('billing:view')),
):
    """Get current plan and usage for the organization.

    Surfaces the org's running credit balance + tier cap as the headline
    (the primary free-tier lever; 100 credits ≈ $1), with USD / token /
    storage / sandbox as informational sub-section data.
    """

    # Sync usage to get accurate counts
    await sync_plan_usage(org_id)

    plan = await get_org_plan(org_id)

    # Resolve plan name + tier + budget (credits + cost + resources) up front.
    plan_name = plan["plan_name"] if plan else "org_free"
    tier = get_plan_tier(plan_name)
    budget = await UsageService().get_budget_status(org_id)
    cost = budget.get("cost_usd", {})
    credits = budget.get("credits", {})

    if not plan:
        # No row yet (backfill pending) — surface the org_free defaults
        # from the single source of truth (plan_tiers.py) so the UI
        # never sees a different answer than the quota middleware.
        return PlanLimits(
            plan_name=tier.name,
            display_name=tier.display_name,
            credits_used=float(credits.get("used", 0.0)),
            credits_soft_limit=float(tier.credits_soft_limit),
            credits_hard_limit=float(tier.credits_hard_limit),
            credits_status=str(credits.get("status", "ok")),
            cost_used_usd=float(cost.get("used", 0.0)),
            cost_soft_limit_usd=float(tier.cost_soft_limit_usd),
            cost_hard_limit_usd=float(tier.cost_hard_limit_usd),
            cost_status=str(cost.get("status", "ok")),
            seats_limit=tier.seats_limit,
            seats_used=0,
            references_limit=tier.references_limit,
            references_used=0,
            tokens_used=int(budget.get("tokens", {}).get("used", 0)),
            storage_mb_used=float(budget.get("storage_mb", {}).get("used", 0.0)),
            sandbox_seconds_used=float(budget.get("sandbox_seconds", {}).get("used", 0.0)),
            active=True,
        )

    return PlanLimits(
        plan_name=plan["plan_name"],
        display_name=tier.display_name,
        credits_used=float(credits.get("used", 0.0)),
        credits_soft_limit=float(credits.get("soft_limit", tier.credits_soft_limit)),
        credits_hard_limit=float(credits.get("hard_limit", tier.credits_hard_limit)),
        credits_status=str(credits.get("status", "ok")),
        cost_used_usd=float(cost.get("used", 0.0)),
        cost_soft_limit_usd=float(cost.get("soft_limit", tier.cost_soft_limit_usd)),
        cost_hard_limit_usd=float(cost.get("hard_limit", tier.cost_hard_limit_usd)),
        cost_status=str(cost.get("status", "ok")),
        seats_limit=plan["seats_limit"],
        seats_used=plan["seats_used"],
        references_limit=plan["references_limit"],
        references_used=plan["references_used"],
        tokens_used=int(budget.get("tokens", {}).get("used", 0)),
        storage_mb_used=float(budget.get("storage_mb", {}).get("used", 0.0)),
        sandbox_seconds_used=float(budget.get("sandbox_seconds", {}).get("used", 0.0)),
        active=plan["active"],
        stripe_subscription_id=plan.get("stripe_subscription_id"),
        subscription_status=plan.get("subscription_status"),
        current_period_end=plan["current_period_end"].isoformat() if plan.get("current_period_end") else None,
    )


@router.post("/subscribe", response_model=dict)
async def subscribe(
    request: SubscribeRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
        _check_billing_edit: dict = Depends(require_org_permission_dep('billing:edit')),
):
    """Create a Stripe checkout session for subscription."""
    _require_paid_plans_enabled()

    # Check if Stripe is configured
    stripe_api_key = getattr(get_settings(), "stripe_secret_key", None) or ""
    if not stripe_api_key or stripe_api_key == "":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe is not configured. Please set STRIPE_SECRET_KEY.",
        )

    try:
        import stripe
        stripe.api_key = stripe_api_key

        plan_def = PLAN_DEFINITIONS.get(request.plan_name)
        if not plan_def:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown plan: {request.plan_name}",
            )

        # Get or create Stripe customer for org
        client = await get_postgres_client()
        org = await client.fetchrow(
            "SELECT name, settings FROM organizations WHERE id = $1",
            org_id,
        )
        if not org:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Organization not found",
            )

        stripe_customer_id = None
        if org.get("settings"):
            settings_data = _get_settings_data(org["settings"])
            stripe_customer_id = settings_data.get("stripe_customer_id")

        # Audit 2026-06-22 B1.25 — wrap Stripe customer + UPDATE in a
        # transaction so a failed UPDATE can't orphan a Stripe customer.
        async with client.transaction():
            if not stripe_customer_id:
                # Create Stripe customer
                customer = await _stripe_call(
                    stripe.Customer.create,
                    name=org["name"],
                    metadata={"org_id": org_id},
                )
                stripe_customer_id = customer.id

                # Save customer ID to org settings
                settings_data = _get_settings_data(org["settings"]) if org.get("settings") else {}
                settings_data["stripe_customer_id"] = stripe_customer_id

                await client.execute(
                    "UPDATE organizations SET settings = $1 WHERE id = $2",
                    settings_data,
                    org_id,
                )

        # Create checkout session
        session = await _stripe_call(
            stripe.checkout.Session.create,
            customer=stripe_customer_id,
            payment_method_types=["card"],
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {
                        "name": f"Eden {request.plan_name.title()} Plan",
                        "description": f"{plan_def['seats_limit']} seats, {plan_def['references_limit']} references",
                    },
                    "unit_amount": plan_def["price_monthly"] * 100,
                    "recurring": {"interval": "month"},
                },
                "quantity": 1,
            }],
            mode="subscription",
            success_url=request.success_url,
            cancel_url=request.cancel_url,
            metadata={
                "org_id": org_id,
                "plan_name": request.plan_name,
            },
        )

        return {
            "checkout_url": session.url,
            "session_id": session.id,
        }

    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe SDK not installed. Run: pip install stripe",
        ) from None
    except Exception as e:
        if _is_stripe_client_error(e):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=safe_detail(e, fallback="Invalid Stripe request"),
            ) from e
        logger.error(f"Stripe checkout error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=safe_detail(e, fallback="Failed to create checkout session"),
        ) from e


@router.get("/invoices", response_model=list[InvoiceResponse])
async def get_invoices(org_id: str = Depends(require_path_org_access), user: dict = Depends(get_current_user),
        _check_billing_view: dict = Depends(require_org_permission_dep('billing:view')),
):
    """Get billing invoices for the organization.

    Free-only mode: paid Stripe invoice history is dormant — return the
    same intentional 503 as subscribe/cancel so the portal can show
    not-available copy instead of a false empty invoice list.
    """
    _require_paid_plans_enabled()

    stripe_api_key = getattr(get_settings(), "stripe_secret_key", None) or ""
    if not stripe_api_key or stripe_api_key == "":
        return []  # Return empty if Stripe not configured

    try:
        import stripe
        stripe.api_key = stripe_api_key

        client = await get_postgres_client()
        org = await client.fetchrow(
            "SELECT settings FROM organizations WHERE id = $1",
            org_id,
        )

        if not org or not org.get("settings"):
            return []

        settings_data = _get_settings_data(org["settings"])
        stripe_customer_id = settings_data.get("stripe_customer_id")

        if not stripe_customer_id:
            return []

        # Get invoices from Stripe
        invoices = await _stripe_call(
            stripe.Invoice.list,
            customer=stripe_customer_id,
            limit=10,
        )

        return [
            InvoiceResponse(
                id=inv.id,
                amount_paid=inv.amount_paid or 0,
                currency=inv.currency or "usd",
                status=inv.status or "unknown",
                created=inv.created or 0,
                invoice_url=inv.hosted_invoice_url,
            )
            for inv in invoices.data
        ]

    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe is not installed.",
        ) from None
    except Exception as e:
        logger.error(f"Stripe invoice error: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe is currently unavailable.",
        ) from e


@router.post("/cancel", response_model=dict)
async def cancel_subscription(org_id: str = Depends(require_path_org_access), user: dict = Depends(get_current_user),
        _check_billing_edit: dict = Depends(require_org_permission_dep('billing:edit')),
):
    """Cancel the current subscription."""
    _require_paid_plans_enabled()

    stripe_api_key = getattr(get_settings(), "stripe_secret_key", None) or ""
    if not stripe_api_key or stripe_api_key == "":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe is not configured.",
        )

    try:
        import stripe
        stripe.api_key = stripe_api_key

        plan = await get_org_plan(org_id)
        if not plan or not plan.get("stripe_subscription_id"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No active subscription found",
            )

        # Cancel at period end
        subscription = await _stripe_call(
            stripe.Subscription.modify,
            plan["stripe_subscription_id"],
            cancel_at_period_end=True,
        )

        # Update local record
        client = await get_postgres_client()
        await client.execute(
            "UPDATE stripe_subscriptions SET cancel_at_period_end = true, updated_at = NOW() WHERE stripe_subscription_id = $1",
            plan["stripe_subscription_id"],
        )

        return {
            "message": "Subscription will be cancelled at period end",
            "cancel_at": subscription.cancel_at,
        }

    except HTTPException:
        raise
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe SDK not installed.",
        ) from None
    except Exception as e:
        if _is_stripe_client_error(e):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=safe_detail(e, fallback="Invalid Stripe request"),
            ) from e
        logger.error(f"Stripe cancel error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=safe_detail(e, fallback="Failed to cancel subscription"),
        ) from e


# ============================================================================
# Stripe Webhook Handler
# ============================================================================

async def _process_stripe_webhook_event(event: dict) -> dict[str, Any]:
    """Idempotent Stripe event ingest + optional subscription sync.

    Always stores the event (verify+log). Plan mutations only run when
    ``PAID_PLANS_ENABLED`` is True. Duplicate ``stripe_event_id`` rows
    are skipped via ``ON CONFLICT DO NOTHING … RETURNING``.
    """
    event_type = event.get("type", "")
    event_id = event.get("id", "")

    client = await get_postgres_client()
    inserted = await client.fetchrow(
        """
        INSERT INTO stripe_events (stripe_event_id, event_type, payload)
        VALUES ($1, $2, $3)
        ON CONFLICT (stripe_event_id) DO NOTHING
        RETURNING stripe_event_id
        """,
        event_id,
        event_type,
        json.dumps(event),
    )
    if inserted is None:
        return {"received": True, "duplicate": True}

    if not PAID_PLANS_ENABLED:
        logger.info(
            "Stripe webhook logged event_type=%s (paid plans disabled; no plan sync)",
            event_type,
        )
        return {"received": True, "processed": False}

    if event_type in ("customer.subscription.updated", "customer.subscription.deleted"):
        await handle_subscription_event(event)

    return {"received": True, "processed": True}


@webhook_router.post("/stripe")
async def stripe_webhook_public(request: Request):
    """Public Stripe webhook — signature verification only, no org auth.

    Stripe cannot call ``/orgs/{org_id}/billing/webhook`` (JWT + path org
    gate). Configure the Stripe endpoint to ``POST /webhooks/stripe``.
    """
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature")

    if not sig_header:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing Stripe signature",
        )

    webhook_secret = getattr(get_settings(), "stripe_webhook_secret", "") or ""
    if not webhook_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe webhook secret is not configured.",
        )

    try:
        import stripe
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe SDK not installed.",
        ) from None

    # Always verify — never parse unverified JSON on failure.
    try:
        event = await _stripe_call(
            stripe.Webhook.construct_event,
            payload,
            sig_header,
            webhook_secret,
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid webhook payload",
        ) from None
    except Exception as e:
        logger.warning("Stripe webhook signature verification failed: %s", redact_all(str(e)))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Stripe signature",
        ) from None

    try:
        # construct_event returns a StripeObject; normalize to a plain dict.
        if hasattr(event, "to_dict"):
            event_dict = event.to_dict()
        elif isinstance(event, dict):
            event_dict = event
        else:
            event_dict = dict(event)
        return await _process_stripe_webhook_event(event_dict)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stripe webhook error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=safe_detail(e, fallback="Webhook processing failed"),
        ) from e


@router.post("/webhook", deprecated=True)
async def stripe_webhook_deprecated(
    request: Request,
    org_id: str = Depends(require_path_org_access),
):
    """Deprecated — use ``POST /webhooks/stripe`` (public, signature-only).

    Kept so existing docs/clients get a clear 410 instead of silent auth
    failures when Stripe cannot present an Eden JWT.
    """
    del request, org_id
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Stripe webhook moved to POST /webhooks/stripe (no org path auth).",
    )


async def handle_subscription_event(event: dict) -> None:
    """Handle subscription.updated or subscription.deleted events."""
    client = await get_postgres_client()

    data = event.get("data", {}).get("object", {})
    stripe_sub_id = data.get("id")
    stripe_customer_id = data.get("customer")
    status = data.get("status")
    current_period_start = data.get("current_period_start")
    current_period_end = data.get("current_period_end")

    if not stripe_sub_id:
        return

    # Prefer org_id from subscription / customer metadata (set at checkout).
    metadata = data.get("metadata") or {}
    org_id = metadata.get("org_id") if isinstance(metadata, dict) else None
    if not org_id:
        org = await client.fetchrow(
            """
            SELECT o.id FROM organizations o
            WHERE o.settings->>'stripe_customer_id' = $1
            """,
            stripe_customer_id,
        )
        if not org:
            logger.warning(f"No org found for Stripe customer: {stripe_customer_id}")
            return
        org_id = str(org["id"])
    else:
        org_id = str(org_id)

    if event.get("type") == "customer.subscription.deleted":
        # Subscription cancelled - revert to free plan
        await client.execute(
            """
            UPDATE stripe_subscriptions
            SET status = 'cancelled', updated_at = NOW()
            WHERE stripe_subscription_id = $1
            """,
            stripe_sub_id,
        )

        # Update org plan to free
        await create_or_update_plan(org_id, "starter")

        # Update plan subscription reference
        plan = await get_org_plan(org_id)
        if plan:
            await client.execute(
                """
                UPDATE org_plans
                SET stripe_subscription_id = NULL, active = true, updated_at = NOW()
                WHERE org_id = $1
                """,
                org_id,
            )

    else:
        # subscription.updated
        # Update or create subscription record
        await client.execute(
            """
            INSERT INTO stripe_subscriptions (org_id, stripe_subscription_id, stripe_customer_id, status, current_period_start, current_period_end)
            VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6))
            ON CONFLICT (stripe_subscription_id) DO UPDATE SET
                status = EXCLUDED.status,
                current_period_start = EXCLUDED.current_period_start,
                current_period_end = EXCLUDED.current_period_end,
                updated_at = NOW()
            """,
            org_id,
            stripe_sub_id,
            stripe_customer_id,
            status,
            current_period_start,
            current_period_end,
        )

        # Update org_plans with subscription reference
        PLAN_DEFINITIONS.get("pro")  # Default to pro on active subscription
        await client.execute(
            """
            UPDATE org_plans
            SET stripe_subscription_id = $1, active = true, updated_at = NOW()
            WHERE org_id = $2
            """,
            stripe_sub_id,
            org_id,
        )


# ───────────────────────────────────────────────────────────────────
# GET /orgs/{org_id}/billing/payment-method
# ───────────────────────────────────────────────────────────────────
# Reads the org's stored Stripe customer id, then asks the Stripe
# API for the default payment method. Returns None for any of:
#   - Stripe not configured (no secret key)
#   - Org has no stripe_customer_id
#   - Customer has no default payment method set
#   - Any Stripe API error (graceful: we don't want a billing UI to
#     break because Stripe is having a bad day; the portal will
#     just hide the card and show "Add a card")

class _PaymentMethodResponse(BaseModel):
    brand: str
    last4: str
    exp_month: int
    exp_year: int


@router.get("/payment-method", response_model=_PaymentMethodResponse | None)
async def get_payment_method(
    org_id: str = Depends(require_path_org_access),
    _user: dict = Depends(get_current_user),
):
    """Return the org's default Stripe payment method, or None.

    Free-only mode: paid card-on-file is dormant — same intentional 503
    as other Stripe paid endpoints. Returns null (not 404) when paid
    plans are enabled but no method is on file so the portal can render
    an "Add a card" CTA without a separate not-found state.
    """
    _require_paid_plans_enabled()

    app_settings = get_settings()
    if not getattr(app_settings, "stripe_secret_key", None):
        return None

    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT settings FROM organizations WHERE id = $1",
        org_id,
    )
    if not row:
        return None
    org_settings = row.get("settings") or {}
    if isinstance(org_settings, str):
        try:
            org_settings = json.loads(org_settings)
        except (ValueError, TypeError):
            org_settings = {}
    customer_id = org_settings.get("stripe_customer_id")
    if not customer_id:
        return None

    # Lazy import: the stripe SDK is only required when this endpoint
    # is actually called. Avoids a hard dep for the rest of the app.
    try:
        import stripe
        stripe.api_key = app_settings.stripe_secret_key
        customer = await _stripe_call(stripe.Customer.retrieve, customer_id)
        default_pm = getattr(
            customer.invoice_settings.default_payment_method, "id", None
        )
        if not default_pm:
            return None
        pm = await _stripe_call(stripe.PaymentMethod.retrieve, default_pm)
        return _PaymentMethodResponse(
            brand=pm.card.brand,
            last4=pm.card.last4,
            exp_month=pm.card.exp_month,
            exp_year=pm.card.exp_year,
        )
    except Exception as exc:
        # Don't break the portal if Stripe is down. Log + return null
        # so the UI falls back to a "card on file unavailable" state.
        logger.warning(
            "Stripe payment-method lookup failed for org %s: %s", org_id, redact_all(str(exc)),
        )
        return None
