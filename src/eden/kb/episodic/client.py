"""Episodic memory client for Eden's Knowledge Base.

Handles job records, pipeline history, and outcome tracking.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Optional, Any
from uuid import UUID

from eden.storage.postgres import get_postgres_client
from eden.kb.shared.audit import evaluate_audn, apply_audn, AUDNResult
from eden.kb.retrieval_logger import get_retrieval_logger

logger = logging.getLogger(__name__)


class EpisodicClient:
    """Client for episodic memory operations.

    Manages job records with full pipeline traces.
    """

    async def insert(self, job_record: dict) -> bool:
        """Insert a new job record."""
        client = await get_postgres_client()

        query = """
            INSERT INTO jobs (
                job_id, request, environment_class, outcome_tier, status,
                edp_history, critic_decisions, routing_history, res,
                fact_check_report, code_history, quality_reports,
                verifier_report, tester_results, archivist_summary,
                kb_reads, agent_proposals, quality_metrics,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW(), NOW()
            )
        """

        try:
            await client.execute(
                query,
                job_record["job_id"],
                json.dumps(job_record.get("request", {})),
                job_record.get("environment_class", "unknown"),
                job_record.get("outcome_tier"),
                job_record.get("status", "planning"),
                json.dumps(job_record.get("edp_history", [])),
                json.dumps(job_record.get("critic_decisions", [])),
                json.dumps(job_record.get("routing_history", [])),
                json.dumps(job_record.get("res")) if job_record.get("res") else None,
                json.dumps(job_record.get("fact_check_report")) if job_record.get("fact_check_report") else None,
                json.dumps(job_record.get("code_history", [])),
                json.dumps(job_record.get("quality_reports", [])),
                json.dumps(job_record.get("verifier_report")) if job_record.get("verifier_report") else None,
                json.dumps(job_record.get("tester_results")) if job_record.get("tester_results") else None,
                json.dumps(job_record.get("archivist_summary")) if job_record.get("archivist_summary") else None,
                json.dumps(job_record.get("kb_reads", [])),
                json.dumps(job_record.get("agent_proposals", [])),
                json.dumps(job_record.get("quality_metrics")) if job_record.get("quality_metrics") else None,
            )
            return True
        except Exception as e:
            logger.error(f"Failed to insert job record: {e}")
            return False

    async def get(self, job_id: str) -> Optional[dict]:
        """Get a job record by job_id."""
        client = await get_postgres_client()

        query = "SELECT * FROM jobs WHERE job_id = $1"
        return await client.fetchrow(query, job_id)

    async def update(self, job_id: str, updates: dict) -> bool:
        """Update a job record with partial updates."""
        client = await get_postgres_client()

        # Build dynamic update query
        set_clauses = []
        params = []
        param_idx = 1

        json_fields = {
            "request", "environment_class", "outcome_tier", "status",
            "edp_history", "critic_decisions", "routing_history", "res",
            "fact_check_report", "code_history", "quality_reports",
            "verifier_report", "tester_results", "archivist_summary",
            "kb_reads", "agent_proposals", "quality_metrics"
        }

        for key, value in updates.items():
            if key == "job_id":
                continue
            if key in json_fields:
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(json.dumps(value))
                param_idx += 1
            elif key == "completed_at":
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(value)
                param_idx += 1
            else:
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(value)
                param_idx += 1

        if not set_clauses:
            return True

        set_clauses.append(f"updated_at = NOW()")
        params.append(job_id)

        query = f"""
            UPDATE jobs SET {', '.join(set_clauses)}
            WHERE job_id = ${param_idx}
        """

        try:
            await client.execute(query, *params)
            return True
        except Exception as e:
            logger.error(f"Failed to update job record: {e}")
            return False

    async def list_jobs(
        self,
        status: Optional[str] = None,
        outcome_tier: Optional[str] = None,
        environment_class: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """List job records with optional filters.

        Note: this used to be called ``list`` but the name shadowed
        the ``list`` builtin in the class namespace, breaking the
        ``-> list[dict]`` annotation. Renamed in 7.0/A1.
        """
        client = await get_postgres_client()

        conditions = []
        params = []
        param_idx = 1

        if status:
            conditions.append(f"status = ${param_idx}")
            params.append(status)
            param_idx += 1

        if outcome_tier:
            conditions.append(f"outcome_tier = ${param_idx}")
            params.append(outcome_tier)
            param_idx += 1

        if environment_class:
            conditions.append(f"environment_class = ${param_idx}")
            params.append(environment_class)
            param_idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        query = f"""
            SELECT * FROM jobs
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """
        params.extend([limit, offset])

        return await client.fetch(query, *params)

    async def search_by_description(
        self,
        query_text: str,
        limit: int = 20,
    ) -> list[dict]:
        """Full-text search on job descriptions."""
        client = await get_postgres_client()

        query = """
            SELECT *, ts_rank(to_tsvector('english', request::text), plainto_tsquery('english', $1)) as rank
            FROM jobs
            WHERE to_tsvector('english', request::text) @@ plainto_tsquery('english', $1)
            ORDER BY rank DESC
            LIMIT $2
        """

        jobs = await client.fetch(query, query_text, limit)

        # Log retrieval for RetrievalTuner
        try:
            logger = get_retrieval_logger()
            await logger.log_retrieval(
                collection="jobs",
                query_text=query_text,
                retrieved_items=[{"id": j.get("job_id")} for j in jobs],
                retrieval_method="fts",
            )
        except Exception as e:
            logger.warning(f"Failed to log retrieval: {e}")

        return jobs

    async def get_recent(
        self,
        days: int = 7,
        limit: int = 50,
    ) -> list[dict]:
        """Get recent job records."""
        client = await get_postgres_client()

        query = """
            SELECT * FROM jobs
            WHERE created_at > NOW() - INTERVAL '1 day' * $1
            ORDER BY created_at DESC
            LIMIT $2
        """

        return await client.fetch(query, days, limit)

    async def get_clustering_candidates(
        self,
        days: int = 30,
        limit: int = 500,
    ) -> list[dict]:
        """Get job records formatted for distiller clustering analysis.

        Extracts clustering-relevant fields from jobs completed in the time window.
        Returns jobs with parsed fields suitable for grouping by environment_class,
        reward_structure_type, and outcome_tier.
        """
        client = await get_postgres_client()

        query = """
            SELECT
                job_id,
                request,
                environment_class,
                outcome_tier,
                status,
                created_at,
                completed_at,
                edp_history,
                critic_decisions,
                res,
                code_history,
                quality_reports,
                verifier_report,
                tester_results,
                archivist_summary
            FROM jobs
            WHERE completed_at IS NOT NULL
              AND completed_at > NOW() - INTERVAL '1 day' * $1
            ORDER BY completed_at DESC
            LIMIT $2
        """

        rows = await client.fetch(query, days, limit)

        # Parse JSON fields and extract clustering dimensions
        candidates = []
        for row in rows:
            edp_history = row.get("edp_history") or []
            first_edp = edp_history[0] if edp_history else {}

            res = row.get("res") or {}
            reward_structure = res.get("reward_structure", {}) if res else {}

            # Extract design metadata from first EDP
            meta = first_edp.get("meta", {}) if first_edp else {}

            candidate = {
                "job_id": row["job_id"],
                "environment_class": row.get("environment_class", "unknown"),
                "outcome_tier": row.get("outcome_tier"),
                "status": row.get("status"),
                "created_at": row.get("created_at"),
                "completed_at": row.get("completed_at"),
                "design_confidence": meta.get("design_confidence"),
                "novelty_assessment": meta.get("novelty_assessment"),
                "reward_structure_type": reward_structure.get("type"),
                "reward_components": reward_structure.get("components", []),
                "difficulty_parameters": first_edp.get("environment", {}).get("difficulty_parameters", {}),
                "design_decisions": first_edp.get("design_decisions", []),
                "known_risks": first_edp.get("known_risks", []),
                "episode_dynamics": first_edp.get("environment", {}).get("episode_dynamics", {}),
                "critic_replan_count": len([c for c in (row.get("critic_decisions") or []) if c.get("routing_decision") == "targeted_replan"]),
                "test_passed": self._extract_test_passed(row),
                "quality_iterations": len(row.get("quality_reports") or []),
            }
            candidates.append(candidate)

        return candidates

    def _extract_test_passed(self, row: dict) -> bool:
        """Extract whether tests passed from job record."""
        tester_results = row.get("tester_results")
        if not tester_results:
            return False
        category = tester_results.get("category", "")
        return category in ("passed", "patch_level")

    async def get_contrastive_jobs(
        self,
        environment_class: str,
        current_job_id: str,
        target_outcomes: list[str],
        limit: int = 10,
    ) -> list[dict]:
        """Get jobs from same env class with specific outcomes for contrastive analysis.

        Args:
            environment_class: The environment class to filter by
            current_job_id: Job ID to exclude (the current job being analyzed)
            target_outcomes: List of outcome tiers to retrieve (e.g., ['gold', 'silver']
                            or ['bronze', 'partial', 'failed'])
            limit: Maximum number of jobs to retrieve per outcome tier

        Returns:
            List of job records with full traces for contrastive analysis
        """
        client = await get_postgres_client()

        query = """
            SELECT * FROM jobs
            WHERE environment_class = $1
              AND job_id != $2
              AND outcome_tier = ANY($3)
              AND completed_at IS NOT NULL
            ORDER BY completed_at DESC
            LIMIT $4
        """

        rows = await client.fetch(
            query,
            environment_class,
            current_job_id,
            target_outcomes,
            limit,
        )

        try:
            retrieval_logger = get_retrieval_logger()
            await retrieval_logger.log_retrieval(
                collection="jobs",
                query_text=f"contrastive:{environment_class}",
                retrieved_items=[{"id": r.get("job_id"), "outcome": r.get("outcome_tier")} for r in rows],
                retrieval_method="contrastive_filter",
            )
        except Exception as e:
            logger.warning(f"Failed to log retrieval: {e}")

        return rows


# Singleton
_episodic_client: Optional[EpisodicClient] = None


def get_episodic_client() -> EpisodicClient:
    """Get the singleton episodic client."""
    global _episodic_client
    if _episodic_client is None:
        _episodic_client = EpisodicClient()
    return _episodic_client