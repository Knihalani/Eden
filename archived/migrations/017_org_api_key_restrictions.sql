-- Migration 017: API key scoping by model and environment class
-- Phase 5.1.3 — adds model_restrictions and env_class_restrictions
-- so a key can be locked to a specific model and/or environment class
-- (e.g. CI keys restricted to gpt-4o-mini on rl_eval environments).

ALTER TABLE org_api_keys
    ADD COLUMN IF NOT EXISTS model_restrictions JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS env_class_restrictions JSONB DEFAULT '[]';

COMMENT ON COLUMN org_api_keys.model_restrictions IS
    'List of model slugs the key is allowed to use. Empty list = no restriction.';
COMMENT ON COLUMN org_api_keys.env_class_restrictions IS
    'List of env_class values the key is allowed to use. Empty list = no restriction.';

CREATE INDEX IF NOT EXISTS idx_org_api_keys_model_restrictions
    ON org_api_keys USING GIN (model_restrictions);
