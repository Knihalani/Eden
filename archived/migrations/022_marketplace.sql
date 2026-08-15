-- Migration 022: Environment Marketplace
-- Closes §5.1 of the roadmap. The schema is intentionally small
-- so the catalog seeding (§5.2) and search/discovery (§5.3) work
-- can ship in parallel.
--
-- Lifecycle:
--   draft -> submitted -> in_review -> published -> (archived | retired)
--   published envs are visible to the public; draft / in_review
--   are private to the author's org.

-- ============================================================================
-- ENV CARDS — the public-facing surface of a marketplace env
-- ============================================================================

CREATE TABLE env_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Authoring
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id),

    -- Spec linkage: each env card points to a spec that drives generation
    spec_id UUID NOT NULL REFERENCES specs(id) ON DELETE RESTRICT,
    -- Optional: an env card can be a fork of another env card
    parent_card_id UUID REFERENCES env_cards(id) ON DELETE SET NULL,

    -- Discovery
    slug TEXT NOT NULL UNIQUE,  -- /marketplace/{slug} is the canonical URL
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,  -- coding, adversarial, simulation, multi-agent, ...
    tags TEXT[] NOT NULL DEFAULT '{}',

    -- Quality metrics (computed at submission; refreshed on demand)
    quality_score NUMERIC(5, 4),         -- 0.0000 - 1.0000
    quality_band TEXT,                    -- low, medium, high (derived)
    outcome_tier TEXT,                    -- low, medium, high
    test_pass_rate NUMERIC(5, 4),         -- fraction of test cases passing
    mutation_score NUMERIC(5, 4),         -- adversarial coverage proxy

    -- Lifecycle
    state TEXT NOT NULL DEFAULT 'draft'
        CHECK (state IN ('draft', 'submitted', 'in_review', 'published', 'archived', 'retired')),
    published_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,

    -- Editorial
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    license TEXT NOT NULL DEFAULT 'mit',  -- mit, apache-2.0, proprietary
    homepage_url TEXT,
    repository_url TEXT,

    -- Usage stats (denormalised for sort/score; updated by triggers)
    fork_count INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    install_count INTEGER NOT NULL DEFAULT 0,

    -- Search
    search_vector tsvector,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_env_cards_org_id ON env_cards (org_id);
CREATE INDEX idx_env_cards_state ON env_cards (state);
CREATE INDEX idx_env_cards_category ON env_cards (category);
CREATE INDEX idx_env_cards_published ON env_cards (published_at DESC NULLS LAST) WHERE state = 'published';
CREATE INDEX idx_env_cards_featured ON env_cards (is_featured) WHERE is_featured = TRUE;
CREATE INDEX idx_env_cards_tags ON env_cards USING GIN (tags);
CREATE INDEX idx_env_cards_search ON env_cards USING GIN (search_vector);
CREATE INDEX idx_env_cards_quality ON env_cards (quality_score DESC NULLS LAST);
CREATE INDEX idx_env_cards_parent ON env_cards (parent_card_id) WHERE parent_card_id IS NOT NULL;

-- Maintain search_vector on insert/update
CREATE OR REPLACE FUNCTION env_cards_search_vector_update() RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C') ||
        setweight(to_tsvector('english', array_to_string(NEW.tags, ' ')), 'B');
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_env_cards_search_vector
    BEFORE INSERT OR UPDATE ON env_cards
    FOR EACH ROW EXECUTE FUNCTION env_cards_search_vector_update();

-- ============================================================================
-- ENV CARD VERSIONS — immutable history of edits (for diff view in §5.4)
-- ============================================================================

CREATE TABLE env_card_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID NOT NULL REFERENCES env_cards(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    spec_id UUID NOT NULL REFERENCES specs(id),
    summary TEXT NOT NULL,
    diff_summary TEXT,           -- human-readable change summary
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (card_id, version)
);

CREATE INDEX idx_env_card_versions_card ON env_card_versions (card_id, version DESC);

-- ============================================================================
-- ENV CARD RATINGS — star ratings on a 1-5 scale (§5.6)
-- ============================================================================

CREATE TABLE env_card_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID NOT NULL REFERENCES env_cards(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (card_id, user_id)
);

CREATE INDEX idx_env_card_ratings_card ON env_card_ratings (card_id);

-- ============================================================================
-- ENV CARD REVIEWS — long-form reviews (§5.6)
-- ============================================================================

CREATE TABLE env_card_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID NOT NULL REFERENCES env_cards(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating_id UUID NOT NULL REFERENCES env_card_ratings(id) ON DELETE CASCADE,
    title TEXT,
    body TEXT NOT NULL,
    -- Moderation
    flagged BOOLEAN NOT NULL DEFAULT FALSE,
    flag_reason TEXT,
    moderated_by UUID REFERENCES users(id),
    moderated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_env_card_reviews_card ON env_card_reviews (card_id, created_at DESC);
CREATE INDEX idx_env_card_reviews_flagged ON env_card_reviews (flagged) WHERE flagged = TRUE;

-- ============================================================================
-- FORK LINEAGE — every card can trace its ancestry (§5.4)
-- ============================================================================

CREATE TABLE env_card_fork_lineage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    descendant_id UUID NOT NULL REFERENCES env_cards(id) ON DELETE CASCADE,
    ancestor_id UUID NOT NULL REFERENCES env_cards(id) ON DELETE CASCADE,
    -- Depth from ancestor to descendant (1 = direct fork)
    depth INTEGER NOT NULL CHECK (depth >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (descendant_id, ancestor_id)
);

CREATE INDEX idx_env_card_fork_lineage_descendant ON env_card_fork_lineage (descendant_id);
CREATE INDEX idx_env_card_fork_lineage_ancestor ON env_card_fork_lineage (ancestor_id);

-- Increment fork_count on the parent when a new card inserts a row that
-- has parent_card_id set.
CREATE OR REPLACE FUNCTION env_cards_increment_fork_count() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.parent_card_id IS NOT NULL THEN
        UPDATE env_cards SET fork_count = fork_count + 1 WHERE id = NEW.parent_card_id;
        -- Record the lineage row at depth 1
        INSERT INTO env_card_fork_lineage (descendant_id, ancestor_id, depth)
        VALUES (NEW.id, NEW.parent_card_id, 1)
        ON CONFLICT (descendant_id, ancestor_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_env_cards_increment_fork_count
    AFTER INSERT ON env_cards
    FOR EACH ROW EXECUTE FUNCTION env_cards_increment_fork_count();
