"""020_intelligence_gap_tables — Phase 9 observability gap roadmap.

Revision ID: 020
Revises: 016
Create Date: 2026-06-10

Adds ~42 tables that lock in the data model for the 16-category
intelligence gap surface (see ``docs/eden-observability-gap-roadmap.md``
and ``docs/observability-gap/*.md``). Every table is created
``IF NOT EXISTS`` so a partial apply is recoverable.

Conventions
-----------
* All tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
* Tables that contain user-derived content (RCA, memory attribution,
  outcomes, satisfaction signals, user feedback, HIL annotations)
  include a comment to remind reviewers to add an RLS policy
  in the follow-up migration (the actual policy is added in 021
  to keep this revision read-only for table creation).

Categories
----------
1. Trace replay & workflow graph: trace_replay_sessions, trace_workflow_graphs
2. RCA & incidents:                rca_analyses, incident_clusters, incident_cluster_members
3. Evaluation quality intelligence:
   eval_versions, eval_failure_clusters, eval_clhf_runs, eval_hil_tasks,
   eval_hil_annotations, eval_pairwise_queues, eval_pairwise_preferences,
   eval_multimodal_runs, eval_to_guardrail_links, eval_modality_declarations,
   eval_boolean_categorical_scores, eval_custom_python_evals,
   eval_user_feedback, eval_auto_dataset_bridge
4. Retrieval intelligence:         retrieval_utilization_scores, retrieval_knowledge_gaps
5. Memory intelligence:            memory_attributions, memory_timeline_events, memory_impact_scores
6. Agent intelligence (incl. Fleet):
   agent_performance_snapshots, agent_relationships, agent_benchmark_runs,
   agent_fleet_identities, agent_fleet_permissions
7. Tool intelligence:              tool_attributions, tool_comparisons
8. Cost intelligence:              cost_efficiency_scores, roi_analyses
9. User intelligence (incl. Conversation, Feedback):
   user_goals, user_satisfaction_signals, conversations, conversation_messages,
   user_feedback, user_segments
10. Governance intelligence (incl. Compliance, Security):
    approval_workflows, approval_requests, compliance_evidence,
    security_scan_runs
11. Outcome/ROI intelligence:      outcomes, outcome_department_rollups
12. Experiment intelligence (incl. Simulation):
    experiment_traffic_splits, experiment_auto_eval_runs,
    experiment_recommendations, simulation_scenarios,
    simulation_runs, what_if_analyses
13. Predictive intelligence (incl. Drift):
    quality_predictions, cost_predictions, capacity_forecasts,
    risk_scores, drift_alerts
14. Autonomous intelligence (incl. NL Interface):
    investigations, autonomous_reports, autonomous_recommendations,
    self_heal_actions, nl_query_log
15. Runtime protection & guardrails: guardrail_policies, guardrail_evaluations,
    intervention_log
16. Decision intelligence:          decision_paths, decision_alternatives,
    decision_scores, agent_trajectories
"""

from alembic import op

revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None


# Helper to avoid repetition
def _table(name: str, body: str, extra_index: str = "") -> None:
    op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
        f"ON {name} (org_id, created_at DESC)"
    )
    if extra_index:
        op.execute(extra_index)


def upgrade() -> None:
    # ─── 1. Trace Replay & Workflow Graph ──────────────────────────
    _table(
        "trace_replay_sessions",
        """
        id          UUID PRIMARY KEY,
        org_id      VARCHAR(128) NOT NULL,
        trace_id    VARCHAR(128) NOT NULL,
        user_id     VARCHAR(128),
        cursor      INTEGER NOT NULL DEFAULT 0,
        state_json  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_trace_replay_sessions_trace "
        "ON trace_replay_sessions (org_id, trace_id)",
    )
    _table(
        "trace_workflow_graphs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        graph_json      TEXT NOT NULL,
        layout_version  VARCHAR(16) NOT NULL DEFAULT 'v1',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_trace_workflow_graphs_trace "
        "ON trace_workflow_graphs (org_id, trace_id)",
    )

    # ─── 2. RCA & Incidents ─────────────────────────────────────────
    _table(
        "rca_analyses",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        category        VARCHAR(32) NOT NULL,
        confidence      DOUBLE PRECISION NOT NULL,
        signals_json    TEXT,
        explanation     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_rca_analyses_trace "
        "ON rca_analyses (org_id, trace_id)",
    )
    _table(
        "incident_clusters",
        """
        id                    UUID PRIMARY KEY,
        org_id                VARCHAR(128) NOT NULL,
        name                  VARCHAR(256) NOT NULL,
        centroid_embedding    TEXT,
        member_count          INTEGER NOT NULL DEFAULT 0,
        severity              VARCHAR(16) NOT NULL DEFAULT 'medium',
        summary               TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "incident_cluster_members",
        """
        cluster_id  UUID NOT NULL,
        trace_id    VARCHAR(128) NOT NULL,
        similarity  DOUBLE PRECISION NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (cluster_id, trace_id)
        """,
    )

    # ─── 3. Evaluation Quality Intelligence ────────────────────────
    _table(
        "eval_versions",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        deployment_sha      VARCHAR(64) NOT NULL,
        prompt_version      VARCHAR(64),
        judge_set_json      TEXT,
        status              VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_eval_versions_sha "
        "ON eval_versions (org_id, deployment_sha)",
    )
    _table(
        "eval_failure_clusters",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        judge_name      VARCHAR(64) NOT NULL,
        signature       VARCHAR(256) NOT NULL,
        member_count    INTEGER NOT NULL DEFAULT 0,
        sample_json     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_clhf_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        examples_json   TEXT NOT NULL,
        generated_metric_json TEXT,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_hil_tasks",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        spec_json       TEXT,
        status          VARCHAR(16) NOT NULL DEFAULT 'open',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_hil_annotations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        task_id         UUID NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        annotator_id    VARCHAR(128),
        label           VARCHAR(64),
        rationale       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_pairwise_queues",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        spec_json       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_pairwise_preferences",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        queue_id        UUID NOT NULL,
        variant_a_id    VARCHAR(128) NOT NULL,
        variant_b_id    VARCHAR(128) NOT NULL,
        preferred       VARCHAR(16) NOT NULL,
        annotator_id    VARCHAR(128),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_multimodal_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        modality        VARCHAR(16) NOT NULL,
        input_url       TEXT,
        score           DOUBLE PRECISION,
        rationale       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_to_guardrail_links",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        judge_name          VARCHAR(64) NOT NULL,
        guardrail_policy_id UUID,
        threshold           DOUBLE PRECISION NOT NULL,
        status              VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_modality_declarations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        modality        VARCHAR(32) NOT NULL,
        config_json     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_boolean_categorical_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        score_type      VARCHAR(16) NOT NULL,
        value           VARCHAR(64) NOT NULL,
        rationale       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_custom_python_evals",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        function_ref    VARCHAR(256) NOT NULL,
        spec_json       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_user_feedback",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128),
        thumbs          VARCHAR(8),
        rating          INTEGER,
        comment         TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_eval_user_feedback_trace "
        "ON eval_user_feedback (org_id, trace_id)",
    )
    _table(
        "eval_auto_dataset_bridge",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        judge_name      VARCHAR(64) NOT NULL,
        source_dataset_id UUID,
        target_dataset_id UUID,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 4. Retrieval Intelligence ─────────────────────────────────
    _table(
        "retrieval_utilization_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        chunk_id        VARCHAR(128) NOT NULL,
        utilized        BOOLEAN NOT NULL,
        score           DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "retrieval_knowledge_gaps",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        query_pattern   TEXT NOT NULL,
        hit_rate        DOUBLE PRECISION,
        utilization     DOUBLE PRECISION,
        status          VARCHAR(16) NOT NULL DEFAULT 'open',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 5. Memory Intelligence ────────────────────────────────────
    _table(
        "memory_attributions",
        """
        id                UUID PRIMARY KEY,
        org_id            VARCHAR(128) NOT NULL,
        trace_id          VARCHAR(128) NOT NULL,
        memory_id         VARCHAR(128) NOT NULL,
        influence_score   DOUBLE PRECISION NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "memory_timeline_events",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        memory_id       VARCHAR(128) NOT NULL,
        event_type      VARCHAR(16) NOT NULL,
        occurred_at     TIMESTAMPTZ NOT NULL,
        payload_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "memory_impact_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        memory_id       VARCHAR(128) NOT NULL,
        score           DOUBLE PRECISION NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 6. Agent Intelligence (incl. Fleet) ───────────────────────
    _table(
        "agent_performance_snapshots",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        agent_id        VARCHAR(128) NOT NULL,
        window          VARCHAR(32) NOT NULL,
        success_rate    DOUBLE PRECISION,
        cost_usd        DOUBLE PRECISION,
        latency_p50_ms  DOUBLE PRECISION,
        latency_p95_ms  DOUBLE PRECISION,
        judge_avg       DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_relationships",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        parent_agent_id VARCHAR(128) NOT NULL,
        child_agent_id  VARCHAR(128) NOT NULL,
        handoff_count   INTEGER NOT NULL DEFAULT 0,
        success_rate    DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_benchmark_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        agent_id        VARCHAR(128) NOT NULL,
        dataset_id      UUID,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        metrics_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_fleet_identities",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        agent_id        VARCHAR(128) NOT NULL,
        display_name    VARCHAR(128) NOT NULL,
        slack_identity  VARCHAR(128),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_fleet_permissions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        agent_id        VARCHAR(128) NOT NULL,
        permission_key  VARCHAR(128) NOT NULL,
        granted         BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 7. Tool Intelligence ──────────────────────────────────────
    _table(
        "tool_attributions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        tool_id         VARCHAR(128) NOT NULL,
        impact_score    DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "tool_comparisons",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        tool_a          VARCHAR(128) NOT NULL,
        tool_b          VARCHAR(128) NOT NULL,
        window          VARCHAR(32) NOT NULL,
        winner          VARCHAR(16),
        metrics_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 8. Cost Intelligence ──────────────────────────────────────
    _table(
        "cost_efficiency_scores",
        """
        id                UUID PRIMARY KEY,
        org_id            VARCHAR(128) NOT NULL,
        group_by_key      VARCHAR(64) NOT NULL,
        group_by_value    VARCHAR(128) NOT NULL,
        cost_per_outcome  DOUBLE PRECISION,
        sample_size       INTEGER NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "roi_analyses",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        window          VARCHAR(32) NOT NULL,
        spend_usd       DOUBLE PRECISION NOT NULL,
        value_usd       DOUBLE PRECISION NOT NULL,
        roi             DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 9. User Intelligence (incl. Conversation, Feedback) ──────
    _table(
        "user_goals",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128) NOT NULL,
        session_id      VARCHAR(128),
        goal            TEXT NOT NULL,
        achieved        BOOLEAN,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "user_satisfaction_signals",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        signal_type     VARCHAR(32) NOT NULL,
        weight          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "conversations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128),
        session_id      VARCHAR(128) NOT NULL,
        title           VARCHAR(256),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "conversation_messages",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        conversation_id UUID NOT NULL,
        role            VARCHAR(16) NOT NULL,
        content         TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv "
        "ON conversation_messages (org_id, conversation_id, created_at)",
    )
    _table(
        "user_feedback",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128),
        thumbs          VARCHAR(8),
        rating          INTEGER,
        comment         TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "user_segments",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128) NOT NULL,
        segment         VARCHAR(32) NOT NULL,
        computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 10. Governance (Compliance, Security) ─────────────────────
    _table(
        "approval_workflows",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        steps_json      TEXT NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "approval_requests",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        workflow_id     UUID NOT NULL,
        requested_by    VARCHAR(128) NOT NULL,
        state           VARCHAR(16) NOT NULL DEFAULT 'pending',
        payload_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "compliance_evidence",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        framework       VARCHAR(16) NOT NULL,
        period_start    TIMESTAMPTZ NOT NULL,
        period_end      TIMESTAMPTZ NOT NULL,
        evidence_json   TEXT NOT NULL,
        generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "security_scan_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        scan_type       VARCHAR(32) NOT NULL,
        findings_json   TEXT,
        severity        VARCHAR(16) NOT NULL DEFAULT 'info',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 11. Outcome/ROI Intelligence ──────────────────────────────
    _table(
        "outcomes",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128),
        type            VARCHAR(32) NOT NULL,
        value           DOUBLE PRECISION,
        department      VARCHAR(64),
        attributed_at   TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "outcome_department_rollups",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        department      VARCHAR(64) NOT NULL,
        window          VARCHAR(32) NOT NULL,
        outcome_count   INTEGER NOT NULL DEFAULT 0,
        cost_usd        DOUBLE PRECISION,
        roi             DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 12. Experiment Intelligence (incl. Simulation) ───────────
    _table(
        "experiment_traffic_splits",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        experiment_id   VARCHAR(128) NOT NULL,
        variant_id      VARCHAR(128) NOT NULL,
        weight          DOUBLE PRECISION NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "experiment_auto_eval_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        experiment_id   VARCHAR(128) NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        results_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "experiment_recommendations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        recommendation  TEXT NOT NULL,
        rationale       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "simulation_scenarios",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        spec_json       TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "simulation_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        scenario_id     UUID NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        result_json     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "what_if_analyses",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        question        TEXT NOT NULL,
        result_json     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 13. Predictive (incl. Drift) ─────────────────────────────
    _table(
        "quality_predictions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        request_id      VARCHAR(128) NOT NULL,
        predicted_score DOUBLE PRECISION,
        confidence      DOUBLE PRECISION,
        model_version   VARCHAR(32) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "cost_predictions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        request_id      VARCHAR(128) NOT NULL,
        predicted_cost_usd DOUBLE PRECISION,
        model_version   VARCHAR(32) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "capacity_forecasts",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        window_start    TIMESTAMPTZ NOT NULL,
        window_end      TIMESTAMPTZ NOT NULL,
        forecast_json   TEXT NOT NULL,
        model_version   VARCHAR(32) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "risk_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        request_id      VARCHAR(128) NOT NULL,
        composite_risk  DOUBLE PRECISION,
        components_json TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "drift_alerts",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        drift_type      VARCHAR(32) NOT NULL,
        severity        VARCHAR(16) NOT NULL DEFAULT 'warning',
        baseline_value  DOUBLE PRECISION,
        current_value   DOUBLE PRECISION,
        details_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 14. Autonomous (incl. NL Interface) ──────────────────────
    _table(
        "investigations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trigger         TEXT NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        findings_json   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "autonomous_reports",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        period_start    TIMESTAMPTZ NOT NULL,
        period_end      TIMESTAMPTZ NOT NULL,
        report_json     TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "autonomous_recommendations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        title           VARCHAR(256) NOT NULL,
        rationale       TEXT,
        action_json     TEXT,
        status          VARCHAR(16) NOT NULL DEFAULT 'open',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "self_heal_actions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        action_type     VARCHAR(32) NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        before_state_json TEXT,
        after_state_json  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "nl_query_log",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128),
        question        TEXT NOT NULL,
        result_json     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 15. Runtime Protection & Guardrails ──────────────────────
    _table(
        "guardrail_policies",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        type            VARCHAR(32) NOT NULL,
        spec_json       TEXT NOT NULL,
        action          VARCHAR(16) NOT NULL DEFAULT 'allow',
        status          VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "guardrail_evaluations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        policy_id       UUID,
        input_json      TEXT,
        verdict         VARCHAR(16) NOT NULL DEFAULT 'allow',
        action_taken    VARCHAR(16) NOT NULL DEFAULT 'allow',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "intervention_log",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        policy_id       UUID,
        trace_id        VARCHAR(128),
        verdict         VARCHAR(16) NOT NULL,
        edited_text     TEXT,
        reason          TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 16. Decision Intelligence ─────────────────────────────────
    _table(
        "decision_paths",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        step_index      INTEGER NOT NULL,
        reasoning       TEXT,
        chosen_action   TEXT,
        path_json       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "decision_alternatives",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        step_index      INTEGER NOT NULL,
        considered      TEXT NOT NULL,
        chosen          BOOLEAN NOT NULL DEFAULT FALSE,
        score           DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "decision_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        score           DOUBLE PRECISION,
        components_json TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_trajectories",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        trajectory_json TEXT NOT NULL,
        analysis_json   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )


def downgrade() -> None:
    # Drop in reverse order (still safe because each table is independent).
    tables = [
        "agent_trajectories", "decision_scores", "decision_alternatives",
        "decision_paths",
        "intervention_log", "guardrail_evaluations", "guardrail_policies",
        "nl_query_log", "self_heal_actions", "autonomous_recommendations",
        "autonomous_reports", "investigations",
        "drift_alerts", "risk_scores", "capacity_forecasts",
        "cost_predictions", "quality_predictions",
        "what_if_analyses", "simulation_runs", "simulation_scenarios",
        "experiment_recommendations", "experiment_auto_eval_runs",
        "experiment_traffic_splits",
        "outcome_department_rollups", "outcomes",
        "security_scan_runs", "compliance_evidence",
        "approval_requests", "approval_workflows",
        "user_segments", "user_feedback", "conversation_messages",
        "conversations", "user_satisfaction_signals", "user_goals",
        "roi_analyses", "cost_efficiency_scores",
        "tool_comparisons", "tool_attributions",
        "agent_fleet_permissions", "agent_fleet_identities",
        "agent_benchmark_runs", "agent_relationships",
        "agent_performance_snapshots",
        "memory_impact_scores", "memory_timeline_events",
        "memory_attributions",
        "retrieval_knowledge_gaps", "retrieval_utilization_scores",
        "eval_auto_dataset_bridge", "eval_user_feedback",
        "eval_custom_python_evals", "eval_boolean_categorical_scores",
        "eval_modality_declarations", "eval_to_guardrail_links",
        "eval_multimodal_runs", "eval_pairwise_preferences",
        "eval_pairwise_queues", "eval_hil_annotations",
        "eval_hil_tasks", "eval_clhf_runs", "eval_failure_clusters",
        "eval_versions",
        "incident_cluster_members", "incident_clusters", "rca_analyses",
        "trace_workflow_graphs", "trace_replay_sessions",
    ]
    for t in tables:
        op.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
