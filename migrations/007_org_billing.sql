-- Billing and subscription management for Eden
-- Tracks org plans, Stripe subscriptions, and webhook events

-- ============================================================================
-- ORGANIZATION PLANS
-- ============================================================================

CREATE TABLE org_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_name TEXT NOT NULL,  -- 'starter', 'pro', 'enterprise'
    stripe_subscription_id TEXT,
    seats_limit INTEGER NOT NULL DEFAULT 5,
    references_limit INTEGER NOT NULL DEFAULT 50,
    jobs_limit INTEGER NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(org_id, plan_name)
);

CREATE INDEX idx_org_plans_org ON org_plans (org_id);
CREATE INDEX idx_org_plans_stripe ON org_plans (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- ============================================================================
-- STRIPE SUBSCRIPTIONS
-- ============================================================================

CREATE TABLE stripe_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stripe_subscription_id TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    status TEXT NOT NULL,  -- 'active', 'past_due', 'cancelled', 'trialing'
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stripe_subs_org ON stripe_subscriptions (org_id);
CREATE INDEX idx_stripe_subs_stripe_id ON stripe_subscriptions (stripe_subscription_id);
CREATE INDEX idx_stripe_subs_customer ON stripe_subscriptions (stripe_customer_id);

-- ============================================================================
-- STRIPE WEBHOOK EVENTS
-- ============================================================================

CREATE TABLE stripe_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,  -- 'customer.subscription.updated', 'customer.subscription.deleted', etc.
    payload JSONB NOT NULL,  -- Full event payload for debugging/auditing
    processed_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stripe_events_type ON stripe_events (event_type);
CREATE INDEX idx_stripe_events_created ON stripe_events (created_at DESC);

-- ============================================================================
-- PLAN LIMITS TRACKING (updated via triggers/statements)
-- ============================================================================

-- Note: Actual usage is calculated dynamically from counts in:
--   - org_members (for seats)
--   - code_references (for references)
--   - jobs (for jobs)
-- But we cache current usage in the org_plans table for quick lookups

ALTER TABLE org_plans ADD COLUMN IF NOT EXISTS seats_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_plans ADD COLUMN IF NOT EXISTS references_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_plans ADD COLUMN IF NOT EXISTS jobs_used INTEGER NOT NULL DEFAULT 0;

-- ============================================================================
-- TRIGGER TO UPDATE PLAN USAGE
-- ============================================================================

CREATE OR REPLACE FUNCTION update_plan_usage()
RETURNS TRIGGER AS $$
BEGIN
    -- Update seats count when org_members changes
    UPDATE org_plans
    SET seats_used = (
        SELECT COUNT(*) FROM org_members WHERE org_id = NEW.org_id
    )
    WHERE org_id = NEW.org_id AND active = true;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to check if org can add more members
CREATE OR REPLACE FUNCTION check_seat_limit(org_id_param UUID)
RETURNS TABLE(can_add BOOLEAN, current_seats INTEGER, seat_limit INTEGER) AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE WHEN (SELECT seats_used FROM org_plans WHERE org_id = org_id_param AND active = true) < (SELECT seats_limit FROM org_plans WHERE org_id = org_id_param AND active = true)
             THEN true ELSE false END,
        COALESCE((SELECT seats_used FROM org_plans WHERE org_id = org_id_param AND active = true), 0),
        COALESCE((SELECT seats_limit FROM org_plans WHERE org_id = org_id_param AND active = true), 0);
END;
$$ LANGUAGE plpgsql;

-- Function to check if org can create more jobs
CREATE OR REPLACE FUNCTION check_job_limit(org_id_param UUID)
RETURNS TABLE(can_create BOOLEAN, current_jobs INTEGER, job_limit INTEGER) AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE WHEN (SELECT jobs_used FROM org_plans WHERE org_id = org_id_param AND active = true) < (SELECT jobs_limit FROM org_plans WHERE org_id = org_id_param AND active = true)
             THEN true ELSE false END,
        COALESCE((SELECT jobs_used FROM org_plans WHERE org_id = org_id_param AND active = true), 0),
        COALESCE((SELECT jobs_limit FROM org_plans WHERE org_id = org_id_param AND active = true), 0);
END;
$$ LANGUAGE plpgsql;

-- Function to sync plan usage with actual counts
CREATE OR REPLACE FUNCTION sync_plan_usage(org_id_param UUID)
RETURNS void AS $$
BEGIN
    UPDATE org_plans
    SET
        seats_used = (SELECT COUNT(*) FROM org_members WHERE org_id = org_id_param),
        references_used = (SELECT COUNT(*) FROM code_references WHERE org_id = org_id_param),
        jobs_used = (SELECT COUNT(*) FROM jobs WHERE org_id = org_id_param)
    WHERE org_id = org_id_param AND active = true;
END;
$$ LANGUAGE plpgsql;

-- Trigger to sync plan usage when org_members changes
CREATE TRIGGER sync_plan_seats_on_member_change
AFTER INSERT OR DELETE ON org_members
FOR EACH ROW
EXECUTE FUNCTION sync_plan_usage(NEW.org_id);

-- ============================================================================
-- DEFAULT PLAN FOR NEW ORGS
-- ============================================================================

-- Add default plan data for existing orgs (run after migration)
-- This will be done in application code for new orgs