-- Retrieval Tuner Schema
-- Phase C.4: Logs retrievals, tracks strategy state, records relevance scores

-- Enable UUID extension if not already (usually in 001 but safe to repeat)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- RETRIEVAL LOGS: Atomic log of every KB retrieval call
-- ============================================================================

CREATE TABLE retrieval_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id VARCHAR(255) NOT NULL,
    agent_id VARCHAR(50) NOT NULL,           -- planner, critic, executor, etc.
    collection VARCHAR(50) NOT NULL,          -- skills, exploits, semantic_memory, graph_entities, jobs
    query_hash VARCHAR(64) NOT NULL,          -- SHA256 of query for deduplication
    query_text TEXT,                          -- Original query text (for FTS queries)
    query_vector_id VARCHAR(255),             -- Reference to embedded query vector
    retrieved_item_ids UUID[] NOT NULL,       -- What was retrieved
    retrieval_method VARCHAR(20) NOT NULL,    -- 'vector', 'hybrid', 'fts', 'graph_traversal'
    filter_conditions JSONB,                  -- What filters were applied
    score_threshold FLOAT,                    -- What threshold was used
    retrieval_latency_ms FLOAT,              -- Performance tracking
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for retrieval_logs
CREATE INDEX idx_rl_job_id ON retrieval_logs (job_id);
CREATE INDEX idx_rl_agent_collection ON retrieval_logs (agent_id, collection);
CREATE INDEX idx_rl_query_hash ON retrieval_logs (query_hash);
CREATE INDEX idx_rl_created ON retrieval_logs (created_at DESC);

-- ============================================================================
-- RETRIEVAL STRATEGY STATE: Per-collection strategy parameters
-- ============================================================================

CREATE TABLE retrieval_strategy_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection VARCHAR(50) NOT NULL UNIQUE,

    -- Vector search params
    score_threshold FLOAT DEFAULT 0.7,
    default_limit INT DEFAULT 20,

    -- Hybrid search params
    dense_weight FLOAT DEFAULT 0.6,
    sparse_weight FLOAT DEFAULT 0.4,

    -- Filter preferences (which metadata fields to prioritize)
    preferred_filters JSONB DEFAULT '{}',

    -- Relevance tracking
    queries_analyzed INT DEFAULT 0,
    relevant_count INT DEFAULT 0,
    irrelevant_count INT DEFAULT 0,

    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    last_adjusted_at TIMESTAMPTZ,
    adjustment_reason TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize default strategies for each KB collection
INSERT INTO retrieval_strategy_state (collection) VALUES
    ('skills'),
    ('exploits'),
    ('semantic_memory'),
    ('graph_entities'),
    ('jobs')
ON CONFLICT (collection) DO NOTHING;

-- ============================================================================
-- RETRIEVAL RELEVANCE SCORES: Post-hoc relevance per retrieved item
-- ============================================================================

CREATE TABLE retrieval_relevance_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    retrieval_log_id UUID NOT NULL REFERENCES retrieval_logs(id) ON DELETE CASCADE,
    item_id UUID NOT NULL,
    is_relevant BOOLEAN NOT NULL,
    relevance_signal TEXT,                    -- 'appeared_in_reasoning', 'used_in_code', 'referenced_by_proposal'
    scored_by VARCHAR(50) NOT NULL,          -- 'archivist', 'llm_analysis', 'automatic'
    scored_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(retrieval_log_id, item_id)
);

-- Index for retrieval_relevance_scores
CREATE INDEX idx_rrs_log_id ON retrieval_relevance_scores (retrieval_log_id);
-- Partial index for finding irrelevant items (for analysis)
CREATE INDEX idx_rrs_irrelevant ON retrieval_relevance_scores (is_relevant) WHERE is_relevant = FALSE;