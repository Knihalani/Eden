-- June 2026: Labeling queue + IAA (Phase D).
--
-- Three tables close the Cat 3 HiL gap (Laminar parity:
-- the labeling queue is one of their 5 numbered surface
-- features).
--
-- The flow:
--   1. Operator seeds the queue: ``INSERT INTO labeling_items``.
--   2. Annotator logs in → ``GET /labeling/queue/{user}``
--      returns the next N items assigned to them (or
--      unassigned + matching their skill).
--   3. Annotator submits: ``POST /labeling/annotate`` →
--      ``INSERT INTO annotations``.
--   4. After 2+ annotators label the same item, the IAA
--      math kicks in: ``GET /labeling/iia`` returns
--      Cohen's kappa + Krippendorff's alpha per item +
--      overall.
--   5. Approved annotations are exported to a Cat 3
--      dataset (``POST /labeling/export``).
--
-- Three tables:
--
-- labeling_items
--   * id, org_id, source (trace_id / span_id / dataset_id /
--     synthetic_qa_id), payload (the content to label),
--     assigned_to (the annotator who should pick this
--     up — nullable for "any annotator"),
--     status (pending / in_progress / completed /
--     skipped), created_at.
--
-- annotations
--   * id, item_id, annotator_id, label (the categorical
--     or scalar label), confidence (0-1), notes, time_spent_ms,
--     created_at. UNIQUE (item_id, annotator_id) so an
--     annotator can revise their label but not double-submit.
--
-- labeling_assignments
--   * id, item_id, annotator_id, assigned_at, completed_at.
--     Tracks WHO picked up WHAT, for IAA math + audit.

CREATE TABLE IF NOT EXISTS labeling_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- Where the item came from. Exactly one of these
    -- should be set.
    source_trace_id TEXT,
    source_span_id  TEXT,
    source_dataset_id UUID,
    source_synthetic_qa_id TEXT,
    -- The content to label. For traces / spans, this is
    -- the request_body + response_body; for datasets,
    -- the input + expected_output; for Q/A, the question
    -- + answer.
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The label schema: e.g. {"type": "thumbs", "options":
    -- ["up", "down"]} or {"type": "1-5", "min": 1, "max": 5}
    -- or {"type": "pairwise", "options": ["a", "b"]}.
    -- The UI reads this to render the right widget.
    label_schema    JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Optional human-readable prompt shown to the
    -- annotator above the item.
    prompt          TEXT,
    -- The annotator this item is assigned to. NULL =
    -- "any qualified annotator" — the queue service
    -- picks the next available.
    assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
    -- ``pending`` → ``in_progress`` (when an annotator
    -- starts) → ``completed`` (when N annotations
    -- collected) or ``skipped`` (annotator flagged it
    -- as un-labelable).
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
    -- Tags for filtering / grouping.
    tags            TEXT[] NOT NULL DEFAULT '{}',
    -- How many annotations are needed to mark this item
    -- "completed". Default 1 (single-annotator); raise
    -- to 2+ for IAA-bearing items.
    annotations_required INT NOT NULL DEFAULT 1
        CHECK (annotations_required >= 1 AND annotations_required <= 10),
    -- Skill hint: the queue service prefers annotators
    -- with the matching skill. Stored as an array of
    -- skill slugs (``["span-eval", "rag"]``).
    required_skills TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_labeling_items_org_status
    ON labeling_items (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_labeling_items_assigned
    ON labeling_items (org_id, assigned_to, status, created_at DESC)
    WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_labeling_items_unassigned
    ON labeling_items (org_id, created_at DESC)
    WHERE assigned_to IS NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_labeling_items_required_skills
    ON labeling_items USING GIN (required_skills);


CREATE TABLE IF NOT EXISTS annotations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    item_id         UUID NOT NULL REFERENCES labeling_items(id) ON DELETE CASCADE,
    annotator_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The label. Categorical (e.g. ``"up"``) or scalar
    -- (e.g. ``4``) or structured (e.g. ``{"winner": "a",
    -- "margin": 0.3}`` for pairwise). Storing as JSONB
    -- so we can support all three without schema churn.
    label           JSONB NOT NULL,
    -- 0-1. The annotator's self-reported confidence.
    confidence      NUMERIC(3, 2) NOT NULL DEFAULT 0.5
        CHECK (confidence >= 0 AND confidence <= 1),
    notes           TEXT,
    -- Time spent in ms. Optional; lets the operator
    -- surface "this took 5 minutes" in the dashboard.
    time_spent_ms   INT,
    -- Skills exercised on this item. Mirrors
    -- ``labeling_items.required_skills`` so we can
    -- build a "this annotator's skills over time" report.
    skills_exercised TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- An annotator can revise their label, but not
    -- double-submit. The (item, annotator) pair is
    -- unique.
    UNIQUE (item_id, annotator_id)
);

CREATE INDEX IF NOT EXISTS idx_annotations_item
    ON annotations (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_annotator
    ON annotations (annotator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_org_created
    ON annotations (org_id, created_at DESC);


CREATE TABLE IF NOT EXISTS labeling_assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    item_id         UUID NOT NULL REFERENCES labeling_items(id) ON DELETE CASCADE,
    annotator_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Set when the annotator starts. NULL = "still pending".
    started_at      TIMESTAMPTZ,
    -- Set when the annotator submits. NULL = "still
    -- in progress".
    completed_at    TIMESTAMPTZ,
    -- Why the assignment was made:
    --   * "auto"   — queue service picked the annotator
    --   * "manual" — admin assigned via the dashboard
    --   * "self"   — annotator self-assigned
    source          TEXT NOT NULL DEFAULT 'auto'
        CHECK (source IN ('auto', 'manual', 'self')),
    UNIQUE (item_id, annotator_id)
);

CREATE INDEX IF NOT EXISTS idx_labeling_assignments_org
    ON labeling_assignments (org_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_labeling_assignments_annotator
    ON labeling_assignments (annotator_id, completed_at)
    WHERE completed_at IS NULL;


-- Trigger: keep ``updated_at`` fresh on every UPDATE.
CREATE OR REPLACE FUNCTION labeling_touch_updated() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_labeling_items_touch_updated ON labeling_items;
CREATE TRIGGER trg_labeling_items_touch_updated
    BEFORE UPDATE ON labeling_items
    FOR EACH ROW EXECUTE FUNCTION labeling_touch_updated();

DROP TRIGGER IF EXISTS trg_annotations_touch_updated ON annotations;
CREATE TRIGGER trg_annotations_touch_updated
    BEFORE UPDATE ON annotations
    FOR EACH ROW EXECUTE FUNCTION labeling_touch_updated();


COMMENT ON TABLE labeling_items IS
    'Phase D: items in the labeling queue. Created from traces, '
    'spans, datasets, or synthetic Q/A (Phase J).';
COMMENT ON TABLE annotations IS
    'Phase D: per-annotator label. (item, annotator) is UNIQUE so '
    'a label can be revised but not double-submitted.';
COMMENT ON TABLE labeling_assignments IS
    'Phase D: tracks WHO picked up WHAT. Powers the IAA math '
    '(overlap of annotators per item) and the audit log.';
