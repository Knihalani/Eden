"""Gold layer — curated datasets and materialized views from Silver → Gold.

Transforms cleaned Silver data into:
- Training datasets (input/output pairs with quality scores)
- Benchmark suites (canonical evaluation sets)
- Evaluation datasets (test sets for regression detection)
- Aggregated KPIs (pre-computed metrics for dashboards)

Usage:
    from eden.data_platform.gold_layer import GoldLayerEngine
    engine = GoldLayerEngine()
    datasets = await engine.generate_training_datasets(org_id="...")
    kpis = await engine.compute_kpis(org_id="...", days=30)
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class TrainingDataPoint:
    """A single curated training data point."""

    datapoint_id: str
    tenant_id: str
    job_id: str
    input: str
    output: str
    quality_score: float
    complexity_tier: str
    framework: str
    environment_class: str
    curriculum_tier: str = "standard"  # standard | advanced | expert
    tags: list[str] = field(default_factory=list)
    lineage: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


@dataclass
class BenchmarkSuite:
    """A curated benchmark suite for evaluation."""

    suite_id: str
    tenant_id: str
    name: str
    description: str
    environment_class: str
    difficulty: str  # easy | medium | hard | adversarial
    datapoints: list[dict[str, Any]] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


@dataclass
class KPIBundle:
    """Pre-computed KPIs for an organization."""

    org_id: str
    period_days: int
    period_start: str
    period_end: str

    # Pipeline metrics
    total_jobs: int
    successful_jobs: int
    failed_jobs: int
    success_rate: float
    avg_duration_ms: float
    p95_duration_ms: float
    median_duration_ms: float

    # Quality metrics
    gold_outcome_rate: float
    test_pass_rate: float
    avg_quality_score: float
    adversarial_issues_found: int

    # Cost metrics
    total_cost_usd: float
    avg_cost_per_job: float
    total_tokens: int
    avg_tokens_per_job: float

    # Usage breakdown
    jobs_by_environment_class: dict[str, int]
    jobs_by_framework: dict[str, int]
    jobs_by_outcome_tier: dict[str, int]
    cost_by_model: dict[str, float]
    tokens_by_model: dict[str, int]

    # Data quality
    data_quality_score: float
    pii_incidents: int
    quarantine_rate: float

    computed_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


class GoldLayerEngine:
    """Engine for producing Gold-layer curated datasets and KPIs.

    Operates on Silver-layer data to produce:
    1. Training datasets (high-quality input/output pairs)
    2. Benchmark suites (canonical evaluation sets)
    3. Aggregated KPIs (pre-computed metrics)
    """

    def __init__(self) -> None:
        self._postgres_client: Any | None = None

    async def _get_postgres(self) -> Any:
        if self._postgres_client is None:
            from eden.storage.postgres import get_postgres_client
            self._postgres_client = await get_postgres_client()
        return self._postgres_client

    # ── Training Dataset Generation ──────────────────────────────────────

    async def generate_training_datasets(
        self,
        tenant_id: str,
        min_quality_score: float = 0.7,
        since: datetime | None = None,
        limit: int = 10000,
    ) -> list[TrainingDataPoint]:
        """Generate training dataset from high-quality Silver traces.

        Filters for:
        - quality_score >= min_quality_score
        - outcome = success
        - no PII detected
        - test pass rate > 0.6
        """
        client = await self._get_postgres()
        cutoff = since or (datetime.now(UTC) - timedelta(days=90))

        rows = await client.fetch(
            """
            SELECT
                j.job_id,
                j.org_id,
                j.description as input,
                j.generated_code as output,
                j.environment_class,
                j.framework,
                j.quality_score,
                j.outcome_tier,
                j.duration_ms,
                j.created_at,
                COALESCE(t.passed_count::float / NULLIF(t.test_count, 0), 0) as pass_rate
            FROM jobs j
            LEFT JOIN job_test_results t ON t.job_id = j.job_id
            WHERE j.org_id = $1
              AND j.created_at >= $2
              AND j.quality_score >= $3
              AND j.outcome_tier IN ('gold', 'silver')
              AND (j.pii_detected = FALSE OR j.pii_detected IS NULL)
            ORDER BY j.quality_score DESC, j.created_at DESC
            LIMIT $4
            """,
            tenant_id,
            cutoff.isoformat(),
            min_quality_score,
            limit,
        )

        datapoints: list[TrainingDataPoint] = []
        for row in rows:
            pass_rate = row.get("pass_rate") or 0.0
            if pass_rate < 0.6:
                continue

            quality = row.get("quality_score") or 0.0
            complexity = self._classify_complexity(quality, pass_rate, row.get("duration_ms", 0))

            dp = TrainingDataPoint(
                datapoint_id=f"dp_{row['job_id']}",
                tenant_id=row["org_id"],
                job_id=row["job_id"],
                input=row["input"] or "",
                output=row["output"] or "",
                quality_score=quality,
                complexity_tier=complexity,
                framework=row.get("framework") or "unknown",
                environment_class=row.get("environment_class") or "custom",
                curriculum_tier="standard" if quality < 0.85 else ("advanced" if quality < 0.95 else "expert"),
                tags=[row.get("environment_class") or "custom", row.get("framework") or "unknown"],
                lineage=[f"job:{row['job_id']}", f"silver:{row['created_at']}"],
            )
            datapoints.append(dp)

        logger.info(f"Generated {len(datapoints)} training datapoints for tenant {tenant_id}")
        return datapoints

    def _classify_complexity(self, quality: float, pass_rate: float, duration_ms: int) -> str:
        """Classify a data point by complexity tier."""
        if quality > 0.9 and pass_rate > 0.9 and duration_ms > 120000:
            return "expert"
        if quality > 0.8 and pass_rate > 0.75:
            return "advanced"
        return "standard"

    async def store_training_dataset(
        self,
        tenant_id: str,
        name: str,
        datapoints: list[TrainingDataPoint],
        tags: list[str] | None = None,
    ) -> str:
        """Store a curated training dataset in PostgreSQL.

        Returns the dataset_id.
        """
        client = await self._get_postgres()
        dataset_id = f"tds_{tenant_id}_{datetime.now(UTC).strftime('%Y%m%d_%H%M%S')}"

        # Insert dataset metadata
        await client.execute(
            """
            INSERT INTO gold_datasets (
                dataset_id, tenant_id, name, dataset_type, version,
                entry_count, tags, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
            ON CONFLICT (dataset_id) DO UPDATE SET
                entry_count = EXCLUDED.entry_count,
                updated_at = NOW()
            """,
            dataset_id,
            tenant_id,
            name,
            "training",
            "1.0",
            len(datapoints),
            json.dumps(tags or []),
        )

        # Insert individual entries
        for dp in datapoints:
            await client.execute(
                """
                INSERT INTO gold_dataset_entries (
                    entry_id, dataset_id, source_trace_id, source_realm,
                    input_data, expected_data, metadata, extracted_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                ON CONFLICT (entry_id) DO NOTHING
                """,
                dp.datapoint_id,
                dataset_id,
                dp.job_id,
                "eden",
                json.dumps({"input": dp.input}),
                json.dumps({"output": dp.output}),
                json.dumps({
                    "quality_score": dp.quality_score,
                    "complexity_tier": dp.complexity_tier,
                    "framework": dp.framework,
                    "environment_class": dp.environment_class,
                    "curriculum_tier": dp.curriculum_tier,
                    "tags": dp.tags,
                    "lineage": dp.lineage,
                }),
            )

        logger.info(f"Stored training dataset {dataset_id} with {len(datapoints)} entries")
        return dataset_id

    # ── Benchmark Suite Generation ───────────────────────────────────────

    async def generate_benchmark_suite(
        self,
        tenant_id: str,
        environment_class: str,
        difficulty: str = "medium",
        size: int = 50,
    ) -> BenchmarkSuite:
        """Generate a benchmark suite from curated Silver data.

        Selects a diverse set of jobs covering different frameworks,
        complexity levels, and edge cases.
        """
        client = await self._get_postgres()

        rows = await client.fetch(
            """
            SELECT
                j.job_id,
                j.description as input,
                j.generated_code as output,
                j.framework,
                j.quality_score,
                j.outcome_tier,
                COALESCE(t.passed_count::float / NULLIF(t.test_count, 0), 0) as pass_rate
            FROM jobs j
            LEFT JOIN job_test_results t ON t.job_id = j.job_id
            WHERE j.org_id = $1
              AND j.environment_class = $2
              AND j.outcome_tier IN ('gold', 'silver')
              AND j.quality_score >= 0.6
            ORDER BY j.quality_score DESC, RANDOM()
            LIMIT $3
            """,
            tenant_id,
            environment_class,
            size,
        )

        datapoints: list[dict[str, Any]] = []
        for row in rows:
            datapoints.append({
                "job_id": row["job_id"],
                "input": row["input"],
                "output": row["output"],
                "framework": row.get("framework") or "unknown",
                "quality_score": row.get("quality_score") or 0.0,
                "pass_rate": row.get("pass_rate") or 0.0,
            })

        suite = BenchmarkSuite(
            suite_id=f"bench_{tenant_id}_{environment_class}_{datetime.now(UTC).strftime('%Y%m%d')}",
            tenant_id=tenant_id,
            name=f"{environment_class.title()} Benchmark Suite",
            description=f"Canonical {difficulty} benchmark for {environment_class} environments",
            environment_class=environment_class,
            difficulty=difficulty,
            datapoints=datapoints,
            tags=[environment_class, difficulty, "canonical"],
        )

        # Store in DB
        await client.execute(
            """
            INSERT INTO gold_benchmark_suites (
                suite_id, tenant_id, name, description,
                environment_class, difficulty, datapoints_json, tags, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (suite_id) DO UPDATE SET
                datapoints_json = EXCLUDED.datapoints_json,
                updated_at = NOW()
            """,
            suite.suite_id,
            suite.tenant_id,
            suite.name,
            suite.description,
            suite.environment_class,
            suite.difficulty,
            json.dumps(datapoints),
            json.dumps(suite.tags),
        )

        logger.info(f"Generated benchmark suite {suite.suite_id} with {len(datapoints)} datapoints")
        return suite

    # ── KPI Aggregation ──────────────────────────────────────────────────

    async def compute_kpis(
        self,
        org_id: str,
        days: int = 30,
    ) -> KPIBundle:
        """Compute comprehensive KPIs for an organization.

        Aggregates job, quality, cost, and data-quality metrics.
        """
        client = await self._get_postgres()
        now = datetime.now(UTC)
        start = now - timedelta(days=days)

        # Basic job stats
        job_stats = await client.fetchrow(
            """
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE outcome_tier IN ('gold', 'silver')) as successful,
                COUNT(*) FILTER (WHERE outcome_tier IN ('bronze', 'failed')) as failed,
                AVG(duration_ms) as avg_duration,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as median_duration,
                AVG(quality_score) as avg_quality,
                COUNT(*) FILTER (WHERE outcome_tier = 'gold') as gold_count
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2
            """,
            org_id,
            start.isoformat(),
        )

        total_jobs = job_stats["total"] or 0
        successful_jobs = job_stats["successful"] or 0
        failed_jobs = job_stats["failed"] or 0
        success_rate = (successful_jobs / total_jobs * 100) if total_jobs > 0 else 0.0
        avg_duration = job_stats["avg_duration"] or 0.0
        p95_duration = job_stats["p95_duration"] or 0.0
        median_duration = job_stats["median_duration"] or 0.0
        avg_quality = job_stats["avg_quality"] or 0.0
        gold_count = job_stats["gold_count"] or 0
        gold_rate = (gold_count / total_jobs * 100) if total_jobs > 0 else 0.0

        # Test pass rate
        test_stats = await client.fetchrow(
            """
            SELECT
                AVG(passed_count::float / NULLIF(test_count, 0)) as avg_pass_rate,
                SUM(test_count) as total_tests,
                SUM(passed_count) as total_passed
            FROM job_test_results
            WHERE job_id IN (SELECT job_id FROM jobs WHERE org_id = $1 AND created_at >= $2)
            """,
            org_id,
            start.isoformat(),
        )
        avg_pass_rate = (test_stats["avg_pass_rate"] or 0.0) * 100

        # Adversarial issues
        adv_count = await client.fetchval(
            """
            SELECT COUNT(*) FROM job_test_results
            WHERE job_id IN (SELECT job_id FROM jobs WHERE org_id = $1 AND created_at >= $2)
              AND adversarial_issues_found > 0
            """,
            org_id,
            start.isoformat(),
        ) or 0

        # Usage / cost from silver_events
        usage_rows = await client.fetch(
            """
            SELECT
                resource,
                SUM(quantity) as total_quantity,
                SUM(cost_usd) as total_cost,
                model
            FROM silver_events
            WHERE org_id = $1 AND timestamp >= $2 AND event_type = 'llm_call'
            GROUP BY resource, model
            """,
            org_id,
            start.isoformat(),
        )

        total_cost = 0.0
        total_tokens = 0
        cost_by_model: dict[str, float] = {}
        tokens_by_model: dict[str, int] = {}
        for row in usage_rows:
            if row["resource"] == "tokens":
                total_tokens += int(row["total_quantity"] or 0)
                tokens_by_model[row.get("model") or "unknown"] = int(row["total_quantity"] or 0)
            total_cost += float(row["total_cost"] or 0)
            cost_by_model[row.get("model") or "unknown"] = float(row["total_cost"] or 0)

        # Breakdowns by dimension
        class_rows = await client.fetch(
            """
            SELECT environment_class, COUNT(*) as count
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2
            GROUP BY environment_class
            """,
            org_id,
            start.isoformat(),
        )
        jobs_by_class = {r["environment_class"] or "unknown": r["count"] for r in class_rows}

        framework_rows = await client.fetch(
            """
            SELECT framework, COUNT(*) as count
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2
            GROUP BY framework
            """,
            org_id,
            start.isoformat(),
        )
        jobs_by_framework = {r["framework"] or "unknown": r["count"] for r in framework_rows}

        outcome_rows = await client.fetch(
            """
            SELECT outcome_tier, COUNT(*) as count
            FROM jobs
            WHERE org_id = $1 AND created_at >= $2
            GROUP BY outcome_tier
            """,
            org_id,
            start.isoformat(),
        )
        jobs_by_outcome = {r["outcome_tier"] or "unknown": r["count"] for r in outcome_rows}

        # Data quality
        await client.fetchrow(
            """
            SELECT quality_score, pii_detected
            FROM silver_events
            WHERE org_id = $1 AND timestamp >= $2
            ORDER BY timestamp DESC
            LIMIT 1000
            """,
            org_id,
            start.isoformat(),
        )
        # Approximate: count PII incidents
        pii_count = await client.fetchval(
            """
            SELECT COUNT(*) FROM silver_events
            WHERE org_id = $1 AND timestamp >= $2 AND pii_detected = TRUE
            """,
            org_id,
            start.isoformat(),
        ) or 0

        quarantine_count = await client.fetchval(
            """
            SELECT COUNT(*) FROM quarantine_events
            WHERE org_id = $1 AND quarantined_at >= $2
            """,
            org_id,
            start.isoformat(),
        ) or 0

        total_silver = await client.fetchval(
            """
            SELECT COUNT(*) FROM silver_events
            WHERE org_id = $1 AND timestamp >= $2
            """,
            org_id,
            start.isoformat(),
        ) or 1

        quarantine_rate = (quarantine_count / total_silver * 100) if total_silver > 0 else 0.0

        # Build KPI bundle
        kpi = KPIBundle(
            org_id=org_id,
            period_days=days,
            period_start=start.isoformat(),
            period_end=now.isoformat(),
            total_jobs=total_jobs,
            successful_jobs=successful_jobs,
            failed_jobs=failed_jobs,
            success_rate=round(success_rate, 1),
            avg_duration_ms=round(avg_duration, 0),
            p95_duration_ms=round(p95_duration, 0),
            median_duration_ms=round(median_duration, 0),
            gold_outcome_rate=round(gold_rate, 1),
            test_pass_rate=round(avg_pass_rate, 1),
            avg_quality_score=round(avg_quality, 2),
            adversarial_issues_found=adv_count,
            total_cost_usd=round(total_cost, 4),
            avg_cost_per_job=round(total_cost / total_jobs, 4) if total_jobs > 0 else 0.0,
            total_tokens=total_tokens,
            avg_tokens_per_job=round(total_tokens / total_jobs, 0) if total_jobs > 0 else 0.0,
            jobs_by_environment_class=jobs_by_class,
            jobs_by_framework=jobs_by_framework,
            jobs_by_outcome_tier=jobs_by_outcome,
            cost_by_model=cost_by_model,
            tokens_by_model=tokens_by_model,
            data_quality_score=round(1.0 - quarantine_rate / 100, 2),
            pii_incidents=pii_count,
            quarantine_rate=round(quarantine_rate, 2),
        )

        # Persist for fast retrieval
        await self._store_kpi_bundle(kpi)
        return kpi

    async def _store_kpi_bundle(self, kpi: KPIBundle) -> None:
        """Persist a KPI bundle to PostgreSQL for fast dashboard retrieval."""
        client = await self._get_postgres()
        await client.execute(
            """
            INSERT INTO gold_kpi_snapshots (
                org_id, period_days, period_start, period_end,
                total_jobs, successful_jobs, failed_jobs, success_rate,
                avg_duration_ms, p95_duration_ms, median_duration_ms,
                gold_outcome_rate, test_pass_rate, avg_quality_score,
                adversarial_issues_found, total_cost_usd, avg_cost_per_job,
                total_tokens, avg_tokens_per_job,
                jobs_by_env_class, jobs_by_framework, jobs_by_outcome,
                cost_by_model, tokens_by_model,
                data_quality_score, pii_incidents, quarantine_rate,
                computed_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, NOW())
            ON CONFLICT (org_id, period_days, period_start) DO UPDATE SET
                total_jobs = EXCLUDED.total_jobs,
                success_rate = EXCLUDED.success_rate,
                total_cost_usd = EXCLUDED.total_cost_usd,
                computed_at = NOW()
            """,
            kpi.org_id,
            kpi.period_days,
            kpi.period_start,
            kpi.period_end,
            kpi.total_jobs,
            kpi.successful_jobs,
            kpi.failed_jobs,
            kpi.success_rate,
            kpi.avg_duration_ms,
            kpi.p95_duration_ms,
            kpi.median_duration_ms,
            kpi.gold_outcome_rate,
            kpi.test_pass_rate,
            kpi.avg_quality_score,
            kpi.adversarial_issues_found,
            kpi.total_cost_usd,
            kpi.avg_cost_per_job,
            kpi.total_tokens,
            kpi.avg_tokens_per_job,
            json.dumps(kpi.jobs_by_environment_class),
            json.dumps(kpi.jobs_by_framework),
            json.dumps(kpi.jobs_by_outcome_tier),
            json.dumps(kpi.cost_by_model),
            json.dumps(kpi.tokens_by_model),
            kpi.data_quality_score,
            kpi.pii_incidents,
            kpi.quarantine_rate,
        )

    async def get_latest_kpis(self, org_id: str, days: int = 30) -> KPIBundle | None:
        """Retrieve the most recently computed KPI bundle."""
        client = await self._get_postgres()
        row = await client.fetchrow(
            """
            SELECT * FROM gold_kpi_snapshots
            WHERE org_id = $1 AND period_days = $2
            ORDER BY computed_at DESC
            LIMIT 1
            """,
            org_id,
            days,
        )
        if not row:
            return None

        return KPIBundle(
            org_id=row["org_id"],
            period_days=row["period_days"],
            period_start=row["period_start"],
            period_end=row["period_end"],
            total_jobs=row["total_jobs"],
            successful_jobs=row["successful_jobs"],
            failed_jobs=row["failed_jobs"],
            success_rate=row["success_rate"],
            avg_duration_ms=row["avg_duration_ms"],
            p95_duration_ms=row["p95_duration_ms"],
            median_duration_ms=row["median_duration_ms"],
            gold_outcome_rate=row["gold_outcome_rate"],
            test_pass_rate=row["test_pass_rate"],
            avg_quality_score=row["avg_quality_score"],
            adversarial_issues_found=row["adversarial_issues_found"],
            total_cost_usd=row["total_cost_usd"],
            avg_cost_per_job=row["avg_cost_per_job"],
            total_tokens=row["total_tokens"],
            avg_tokens_per_job=row["avg_tokens_per_job"],
            jobs_by_environment_class=json.loads(row["jobs_by_env_class"]) if row["jobs_by_env_class"] else {},
            jobs_by_framework=json.loads(row["jobs_by_framework"]) if row["jobs_by_framework"] else {},
            jobs_by_outcome_tier=json.loads(row["jobs_by_outcome"]) if row["jobs_by_outcome"] else {},
            cost_by_model=json.loads(row["cost_by_model"]) if row["cost_by_model"] else {},
            tokens_by_model=json.loads(row["tokens_by_model"]) if row["tokens_by_model"] else {},
            data_quality_score=row["data_quality_score"],
            pii_incidents=row["pii_incidents"],
            quarantine_rate=row["quarantine_rate"],
            computed_at=row["computed_at"].isoformat() if hasattr(row["computed_at"], "isoformat") else str(row["computed_at"]),
        )

    async def list_gold_datasets(
        self,
        tenant_id: str,
        dataset_type: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List all Gold-layer datasets for a tenant."""
        client = await self._get_postgres()

        if dataset_type:
            rows = await client.fetch(
                """
                SELECT dataset_id, name, dataset_type, version,
                       entry_count, tags, created_at, updated_at
                FROM gold_datasets
                WHERE tenant_id = $1 AND dataset_type = $2
                ORDER BY created_at DESC
                LIMIT $3
                """,
                tenant_id,
                dataset_type,
                limit,
            )
        else:
            rows = await client.fetch(
                """
                SELECT dataset_id, name, dataset_type, version,
                       entry_count, tags, created_at, updated_at
                FROM gold_datasets
                WHERE tenant_id = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                tenant_id,
                limit,
            )

        return [
            {
                "dataset_id": r["dataset_id"],
                "name": r["name"],
                "dataset_type": r["dataset_type"],
                "version": r["version"],
                "entry_count": r["entry_count"],
                "tags": json.loads(r["tags"]) if r["tags"] else [],
                "created_at": r["created_at"].isoformat() if hasattr(r["created_at"], "isoformat") else str(r["created_at"]),
                "updated_at": r["updated_at"].isoformat() if hasattr(r["updated_at"], "isoformat") else str(r["updated_at"]),
            }
            for r in rows
        ]

    async def get_dataset_entries(
        self,
        dataset_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Get entries from a Gold dataset."""
        client = await self._get_postgres()
        rows = await client.fetch(
            """
            SELECT entry_id, source_trace_id, source_realm,
                   input_data, expected_data, metadata, extracted_at
            FROM gold_dataset_entries
            WHERE dataset_id = $1
            ORDER BY extracted_at DESC
            LIMIT $2 OFFSET $3
            """,
            dataset_id,
            limit,
            offset,
        )
        return [
            {
                "entry_id": r["entry_id"],
                "source_trace_id": r["source_trace_id"],
                "source_realm": r["source_realm"],
                "input": json.loads(r["input_data"]) if r["input_data"] else {},
                "expected": json.loads(r["expected_data"]) if r["expected_data"] else {},
                "metadata": json.loads(r["metadata"]) if r["metadata"] else {},
                "extracted_at": r["extracted_at"].isoformat() if hasattr(r["extracted_at"], "isoformat") else str(r["extracted_at"]),
            }
            for r in rows
        ]
