"""Billing and subscription management routes for Eden.

Handles Stripe webhook events, subscription management, and plan limits.
"""

import json
import logging
from datetime import datetime
from typing import Optional
from uuid import uuid4

from fastapi import Depends, APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from eden.api.deps import require_org_permission, get_current_user, get_postgres_client
from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/orgs/{org_id}/billing", tags=["billing"])


# ============================================================================
# Pydantic Models
# ============================================================================

class PlanLimits(BaseModel):
    """Plan limit information."""
    plan_name: str
    seats_limit: int
    seats_used: int
    references_limit: int
    references_used: int
    jobs_limit: int
    jobs_used: int
    active: bool
    stripe_subscription_id: Optional[str] = None
    subscription_status: Optional[str] = None
    current_period_end: Optional[str] = None


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
    invoice_url: Optional[str] = None


# ============================================================================
# Plan Definition (simplified - in production, use Stripe prices)
# ============================================================================

PLAN_DEFINITIONS = {
    "starter": {
        "seats_limit": 5,
        "references_limit": 50,
        "jobs_limit": 100,
        "price_monthly": 29,  # dollars
    },
    "pro": {
        "seats_limit": 15,
        "references_limit": 200,
        "jobs_limit": 500,
        "price_monthly": 79,
    },
    "enterprise": {
        "seats_limit": 50,
        "references_limit": 1000,
        "jobs_limit": 2000,
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


async def get_org_plan(org_id: str) -> Optional[dict]:
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

    # Use a single query with all three counts
    query = """
        SELECT
            (SELECT COUNT(*) FROM org_members WHERE org_id = $1) as seats_used,
            (SELECT COUNT(*) FROM code_references WHERE org_id = $1) as references_used,
            (SELECT COUNT(*) FROM jobs WHERE org_id = $1) as jobs_used
    """
    row = await client.fetchrow(query, org_id)

    if row:
        await client.execute(
            """
            UPDATE org_plans
            SET seats_used = $1, references_used = $2, jobs_used = $3, updated_at = NOW()
            WHERE org_id = $4 AND active = true
            """,
            row["seats_used"],
            row["references_used"],
            row["jobs_used"],
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
            SET plan_name = $1, seats_limit = $2, references_limit = $3, jobs_limit = $4, updated_at = NOW()
            WHERE org_id = $5 AND active = true
            """,
            plan_name,
            plan_def["seats_limit"],
            plan_def["references_limit"],
            plan_def["jobs_limit"],
            org_id,
        )
    else:
        # Create new plan
        await client.execute(
            """
            INSERT INTO org_plans (org_id, plan_name, seats_limit, references_limit, jobs_limit, seats_used, references_used, jobs_used)
            VALUES ($1, $2, $3, $4, $5, 0, 0, 0)
            """,
            org_id,
            plan_name,
            plan_def["seats_limit"],
            plan_def["references_limit"],
            plan_def["jobs_limit"],
        )


async def check_limit(
    org_id: str,
    limit_type: str,  # 'seats', 'references', 'jobs'
) -> bool:
    """Check if org is at or over a limit. Returns True if limit exceeded."""
    plan = await get_org_plan(org_id)
    if not plan:
        # No plan = unlimited (free tier)
        return False

    # Check directly without syncing first (sync is done lazily on plan view)
    if limit_type == "seats":
        return plan["seats_used"] >= plan["seats_limit"]
    elif limit_type == "references":
        return plan["references_used"] >= plan["references_limit"]
    elif limit_type == "jobs":
        return plan["jobs_used"] >= plan["jobs_limit"]

    return False


# ============================================================================
# Routes
# ============================================================================

@router.get("/plans", response_model=PlanLimits)
async def get_plans(org_id: str, user: dict = Depends(get_current_user)):
    """Get current plan and usage for the organization."""
    await require_org_permission("billing:view", org_id)

    # Sync usage to get accurate counts
    await sync_plan_usage(org_id)

    plan = await get_org_plan(org_id)

    if not plan:
        # Return default free plan
        return PlanLimits(
            plan_name="free",
            seats_limit=2,
            seats_used=0,
            references_limit=10,
            references_used=0,
            jobs_limit=20,
            jobs_used=0,
            active=True,
        )

    return PlanLimits(
        plan_name=plan["plan_name"],
        seats_limit=plan["seats_limit"],
        seats_used=plan["seats_used"],
        references_limit=plan["references_limit"],
        references_used=plan["references_used"],
        jobs_limit=plan["jobs_limit"],
        jobs_used=plan["jobs_used"],
        active=plan["active"],
        stripe_subscription_id=plan.get("stripe_subscription_id"),
        subscription_status=plan.get("subscription_status"),
        current_period_end=plan["current_period_end"].isoformat() if plan.get("current_period_end") else None,
    )


@router.post("/subscribe", response_model=dict)
async def subscribe(
    org_id: str,
    request: SubscribeRequest,
    user: dict = Depends(get_current_user),
):
    """Create a Stripe checkout session for subscription."""
    await require_org_permission("billing:edit", org_id)

    # Check if Stripe is configured
    stripe_api_key = getattr(settings, "stripe_secret_key", None) or ""
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

        stripe_customer_id = None
        if org and org.get("settings"):
            settings_data = _get_settings_data(org["settings"])
            stripe_customer_id = settings_data.get("stripe_customer_id")

        if not stripe_customer_id:
            # Create Stripe customer
            customer = stripe.Customer.create(
                name=org["name"],
                metadata={"org_id": org_id},
            )
            stripe_customer_id = customer.id

            # Save customer ID to org settings
            settings_data = _get_settings_data(org["settings"]) if org and org.get("settings") else {}
            settings_data["stripe_customer_id"] = stripe_customer_id

            await client.execute(
                "UPDATE organizations SET settings = $1 WHERE id = $2",
                settings_data,
                org_id,
            )

        # Create checkout session
        session = stripe.checkout.Session.create(
            customer=stripe_customer_id,
            payment_method_types=["card"],
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {
                        "name": f"Eden {request.plan_name.title()} Plan",
                        "description": f"{plan_def['seats_limit']} seats, {plan_def['references_limit']} references, {plan_def['jobs_limit']} jobs/month",
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

    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe SDK not installed. Run: pip install stripe",
        )
    except Exception as e:
        logger.error(f"Stripe checkout error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create checkout session: {str(e)}",
        )


@router.get("/invoices", response_model=list[InvoiceResponse])
async def get_invoices(org_id: str, user: dict = Depends(get_current_user)):
    """Get billing invoices for the organization."""
    await require_org_permission("billing:view", org_id)

    stripe_api_key = getattr(settings, "stripe_secret_key", None) or ""
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
        invoices = stripe.Invoice.list(
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
        return []
    except Exception as e:
        logger.error(f"Stripe invoice error: {e}")
        return []


@router.post("/cancel", response_model=dict)
async def cancel_subscription(org_id: str, user: dict = Depends(get_current_user)):
    """Cancel the current subscription."""
    await require_org_permission("billing:edit", org_id)

    stripe_api_key = getattr(settings, "stripe_secret_key", None) or ""
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
        subscription = stripe.Subscription.modify(
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

    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe SDK not installed.",
        )
    except Exception as e:
        logger.error(f"Stripe cancel error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to cancel subscription: {str(e)}",
        )


# ============================================================================
# Stripe Webhook Handler
# ============================================================================

@router.post("/webhook")
async def stripe_webhook(
    org_id: str,
    request: Request,
):
    """Handle Stripe webhook events."""
    stripe_api_key = getattr(settings, "stripe_secret_key", None) or ""
    if not stripe_api_key or stripe_api_key == "":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe is not configured.",
        )

    try:
        import stripe
        stripe.api_key = stripe_api_key

        payload = await request.body()
        sig_header = request.headers.get("stripe-signature")

        if not sig_header:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing Stripe signature",
            )

        # Verify webhook signature
        try:
            event = stripe.Webhook.construct_event(
                payload,
                sig_header,
                getattr(settings, "stripe_webhook_secret", ""),
            )
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid webhook payload",
            )
        except Exception as e:
            # If no webhook secret configured, just parse
            logger.warning(f"Stripe webhook verification failed: {e}")
            event = json.loads(payload)

        event_type = event.get("type", "")
        event_id = event.get("id", "")

        # Store event for debugging
        client = await get_postgres_client()
        await client.execute(
            """
            INSERT INTO stripe_events (stripe_event_id, event_type, payload)
            VALUES ($1, $2, $3)
            ON CONFLICT (stripe_event_id) DO NOTHING
            """,
            event_id,
            event_type,
            json.dumps(event),
        )

        # Handle subscription events
        if event_type in ("customer.subscription.updated", "customer.subscription.deleted"):
            await handle_subscription_event(event)

        return {"received": True}

    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe SDK not installed.",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stripe webhook error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Webhook processing failed: {str(e)}",
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

    # Find org by Stripe customer
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
        plan_def = PLAN_DEFINITIONS.get("pro")  # Default to pro on active subscription
        await client.execute(
            """
            UPDATE org_plans
            SET stripe_subscription_id = $1, active = true, updated_at = NOW()
            WHERE org_id = $2
            """,
            stripe_sub_id,
            org_id,
        )