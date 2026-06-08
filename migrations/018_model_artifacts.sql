-- Migration 018: Model artifact + evaluation tables
-- Phase 6.7.1: persistence backing for the LLMOps ModelArtifactRegistry.

CREATE TABLE IF NOT EXISTS model_artifacts (
    id TEXT PRIMARY KEY,
    model_family TEXT NOT NULL,
    model_version TEXT NOT NULL,
    artifact_type TEXT NOT NULL,           -- 'model_weights' | 'adapter' | 'tokenizer' | 'config'
    storage_uri TEXT,                     -- s3://... or local path
    config_hash TEXT,                     -- sha256 of the canonicalised config
    parent_artifact_id TEXT REFERENCES model_artifacts(id) ON DELETE SET NULL,
    training_config JSONB DEFAULT '{}',
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_artifacts_family
    ON model_artifacts (model_family, model_version);

CREATE TABLE IF NOT EXISTS model_evaluations (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES model_artifacts(id) ON DELETE CASCADE,
    eval_name TEXT NOT NULL,
    pass_rate DOUBLE PRECISION,
    cost_per_1k_tokens DOUBLE PRECISION,
    avg_latency_ms DOUBLE PRECISION,
    dataset_id TEXT,
    metadata JSONB DEFAULT '{}',
    evaluated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_evaluations_artifact
    ON model_evaluations (artifact_id, evaluated_at DESC);
