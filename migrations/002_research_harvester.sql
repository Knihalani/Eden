-- Migration 002: Research Harvester Schema
-- Adds research_proposals table for batch processing and framework_versions for tracking

-- ============================================================================
-- RESEARCH PROPOSALS (Batch Queue for Archivist)
-- ============================================================================

CREATE TABLE research_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Source identification
    source_type VARCHAR(50) NOT NULL,  -- arxiv, framework_releases, conference_proceedings, eval_platform
    source_url TEXT,
    paper_id VARCHAR(255),

    -- Content
    title TEXT NOT NULL,
    abstract TEXT,
    findings JSONB NOT NULL DEFAULT '[]',  -- List of extracted findings
    raw_content TEXT,

    -- Framework change detection
    is_framework_change BOOLEAN DEFAULT FALSE,
    framework_name VARCHAR(100),
    previous_version VARCHAR(50),
    new_version VARCHAR(50),

    -- Status
    status VARCHAR(20) DEFAULT 'pending',  -- pending, reviewed, superseded
    archivist_reviewed BOOLEAN DEFAULT FALSE,
    audn_action VARCHAR(20),  -- ADD, UPDATE, DELETE, NONE, CONFLICT

    -- Timestamps
    proposed_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    valid_until TIMESTAMPTZ,  -- When this finding expires

    -- Provenance
    harvester_run_id VARCHAR(100)
);

-- Indexes for research_proposals
CREATE INDEX idx_rp_status ON research_proposals (status);
CREATE INDEX idx_rp_source ON research_proposals (source_type);
CREATE INDEX idx_rp_framework ON research_proposals (framework_name) WHERE is_framework_change = TRUE;
CREATE INDEX idx_rp_pending ON research_proposals (proposed_at DESC) WHERE archivist_reviewed = FALSE;
CREATE INDEX idx_rp_harvester ON research_proposals (harvester_run_id);


-- ============================================================================
-- FRAMEWORK VERSIONS (For tracking VALID_UNTIL on KB entries)
-- ============================================================================

CREATE TABLE framework_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    framework_name VARCHAR(100) NOT NULL,  -- Gymnasium, PettingZoo, MuJoCo, IsaacLab
    version VARCHAR(50) NOT NULL,
    release_date TIMESTAMPTZ,
    changelog_url TEXT,
    is_major BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Unique constraint: no duplicate version for same framework
    UNIQUE(framework_name, version)
);

-- Indexes for framework_versions
CREATE INDEX idx_fv_name ON framework_versions (framework_name);
CREATE INDEX idx_fv_version ON framework_versions (framework_name, version DESC);
CREATE INDEX idx_fv_release ON framework_versions (release_date DESC);
CREATE INDEX idx_fv_major ON framework_versions (framework_name, is_major) WHERE is_major = TRUE;