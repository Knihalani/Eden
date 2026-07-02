"""026_apm_depth_rollups — Cat 22 (APM Depth + Tracing Depth) v1.4 ships.

Revision ID: 026
Revises: 025
Create Date: 2026-06-12

ponytail: per upgradespec §D.1 (Phase 1 cut), the 3 tables this
migration used to create (apm_sampling_decisions,
apm_k8s_enrichment_log, trace_step_profile_links) are deferred to the
OTel Collector + K8s Downward API path. Cat 22 sampling / k8s /
profiling code lives in :mod:`eden.apm_depth` but no longer persists
audit rows — the in-process decision is returned via the route
response envelope and the OTel Collector handles the long-term
storage. Migration retained so the revision chain stays linear; the
upgrade is a no-op.
"""

from __future__ import annotations


revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ponytail: 3 audit tables removed per upgradespec §D.1.
    # See deploy/otel-collector-config.yaml for the OTel Collector
    # tail_sampling + k8sattributes processor config that replaces
    # the in-process enrichment.
    return


def downgrade() -> None:
    # No tables to drop — see upgrade().
    return