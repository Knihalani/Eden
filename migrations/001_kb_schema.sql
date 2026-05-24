-- Eden Knowledge Base Schema
-- PostgreSQL 16+ with JSONB, pgvector, and bitemporal model

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgvector";

-- ============================================================================
-- LAYER 1: EPISODIC MEMORY
-- ============================================================================

CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id VARCHAR(255) UNIQUE NOT NULL,

    -- Request
    request JSONB NOT NULL,
    environment_class VARCHAR(50) NOT NULL,

    -- Outcome and status
    outcome_tier VARCHAR(20),  -- Gold, Silver, Bronze, Partial, Failed
    status VARCHAR(50) NOT NULL,  -- planning, criticizing, refining, etc.

    -- Pipeline history
    edp_history JSONB NOT NULL DEFAULT '[]',
    critic_decisions JSONB NOT NULL DEFAULT '[]',
    routing_history JSONB NOT NULL DEFAULT '[]',

    -- Working state
    res JSONB,
    fact_check_report JSONB,
    code_history JSONB NOT NULL DEFAULT '[]',

    -- Quality tracking
    quality_reports JSONB NOT NULL DEFAULT '[]',

    -- Verification & testing
    verifier_report JSONB,
    tester_results JSONB,

    -- KB provenance
    kb_reads JSONB NOT NULL DEFAULT '[]',
    agent_proposals JSONB NOT NULL DEFAULT '[]',

    -- Quality metrics
    quality_metrics JSONB,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Indexes for episodic memory
CREATE INDEX idx_jobs_job_id ON jobs (job_id);
CREATE INDEX idx_jobs_status ON jobs (status);
CREATE INDEX idx_jobs_outcome ON jobs (outcome_tier);
CREATE INDEX idx_jobs_env_class ON jobs (environment_class);
CREATE INDEX idx_jobs_created ON jobs (created_at DESC);

-- Full-text search on request
CREATE INDEX idx_jobs_fts ON jobs USING GIN (to_tsvector('english', request::text));

-- Time-series optimization
CREATE INDEX idx_jobs_created_desc ON jobs (created_at DESC);

-- ============================================================================
-- LAYER 2: SEMANTIC MEMORY — TEMPORAL KNOWLEDGE GRAPH
-- ============================================================================

CREATE TABLE graph_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Entity identification
    entity_type VARCHAR(50) NOT NULL,  -- EnvironmentClass, DesignPattern, FailureMode, etc.
    name TEXT NOT NULL,

    -- Flexible properties
    properties JSONB NOT NULL DEFAULT '{}',

    -- Bitemporal model
    valid_at TIMESTAMPTZ NOT NULL,      -- When it was true in the world
    recorded_at TIMESTAMPTZ NOT NULL,   -- When Eden learned it
    invalid_at TIMESTAMPTZ,              -- NULL = still valid

    -- Vector embedding for semantic search
    embedding vector(1536),

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE entity_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Link identification
    source_id UUID NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
    edge_type VARCHAR(50) NOT NULL,  -- CAUSES, PREVENTS, ENABLES, IMPROVES, CONTRADICTS, etc.

    -- Flexible properties
    properties JSONB DEFAULT '{}',

    -- Bitemporal model
    valid_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    invalid_at TIMESTAMPTZ,

    -- Constraints
    UNIQUE(source_id, target_id, edge_type)
);

-- Graph indexes
CREATE INDEX idx_ge_type ON graph_entities (entity_type);
CREATE INDEX idx_ge_name ON graph_entities (name);
CREATE INDEX idx_ge_valid_at ON graph_entities (valid_at);
CREATE INDEX idx_ge_recorded_at ON graph_entities (recorded_at);
CREATE INDEX idx_ge_embedding ON graph_entities USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX idx_el_source ON entity_links (source_id);
CREATE INDEX idx_el_target ON entity_links (target_id);
CREATE INDEX idx_el_type ON entity_links (edge_type);
CREATE INDEX idx_el_valid_at ON entity_links (valid_at);

-- Full-text search on entity properties
CREATE INDEX idx_ge_props_fts ON graph_entities USING GIN (to_tsvector('english', properties::text));

-- ============================================================================
-- LAYER 3: PROCEDURAL MEMORY — SKILL LIBRARY
-- ============================================================================

CREATE TABLE skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identification
    name TEXT NOT NULL,
    description TEXT NOT NULL,

    -- Code
    code_template TEXT NOT NULL,
    parameters JSONB DEFAULT '{}',

    -- Applicability
    applicable_env_classes TEXT[] NOT NULL,
    applicable_frameworks TEXT[] NOT NULL,

    -- Quality metrics from validating jobs
    quality_metrics JSONB DEFAULT '{}',

    -- Archivist review
    archivist_reviewed BOOLEAN DEFAULT FALSE,
    confidence_score FLOAT DEFAULT 0.5,

    -- Vector embedding for semantic search
    embedding vector(1536),

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Skill indexes
CREATE INDEX idx_skills_embedding ON skills USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_skills_env_class ON skills USING GIN (applicable_env_classes);
CREATE INDEX idx_skills_framework ON skills USING GIN (applicable_frameworks);
CREATE INDEX idx_skills_archivist ON skills (archivist_reviewed);

-- ============================================================================
-- LAYER 4: EXPLOIT LIBRARY
-- ============================================================================

CREATE TABLE exploits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identification
    category VARCHAR(100) NOT NULL,  -- specification_gaming, reward_tampering, etc.
    name TEXT NOT NULL,

    -- Applicability
    applicable_env_classes TEXT[] NOT NULL,
    applicable_reward_types TEXT[] NOT NULL,

    -- Probe implementation
    probe_code TEXT NOT NULL,
    structural_preconditions JSONB DEFAULT '{}',

    -- Metadata
    discovery_episode_id UUID,
    archivist_rationale TEXT,

    -- Vector embedding for semantic probe retrieval
    embedding vector(1536),

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Exploit indexes
CREATE INDEX idx_exploits_category ON exploits (category);
CREATE INDEX idx_exploits_embedding ON exploits USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- LANGGRAPH CHECKPOINT BLOB STORAGE (for pointer offloading)
-- ============================================================================

CREATE TABLE checkpoint_blobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id VARCHAR(255) NOT NULL,
    field VARCHAR(100) NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(job_id, field)
);

CREATE INDEX idx_cb_job_id ON checkpoint_blobs (job_id);

-- ============================================================================
-- PROMPT VERSIONING
-- ============================================================================

CREATE TABLE prompt_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    agent VARCHAR(50) NOT NULL,
    version INT NOT NULL,
    system_prompt TEXT NOT NULL,
    few_shot_examples JSONB DEFAULT '[]',

    -- Performance metrics
    quality_metrics JSONB DEFAULT '{}',

    -- Status
    active BOOLEAN DEFAULT FALSE,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    promoted_at TIMESTAMPTZ,

    UNIQUE(agent, version)
);

CREATE INDEX idx_pv_agent ON prompt_versions (agent);
CREATE INDEX idx_pv_active ON prompt_versions (agent, active);

-- ============================================================================
-- TRIGGER: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER skills_updated_at
    BEFORE UPDATE ON skills
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();