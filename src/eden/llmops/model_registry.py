"""Eden LLMOps — Model Artifact Registry.

Stores, versions, and retrieves model artifacts used in Eden's pipeline
with delta artifact patterns and evaluation linkage.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, UTC
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class ArtifactType(str, Enum):
    BASE_MODEL = "base_model"
    LORA_ADAPTER = "lora_adapter"
    EMBEDDING_MODEL = "embedding_model"
    REWARD_MODEL = "reward_model"
    JUDGE_MODEL = "judge_model"


@dataclass
class ModelArtifact:
    artifact_id: str
    artifact_type: ArtifactType
    model_family: str
    model_version: str
    provider: str
    storage_uri: str
    config_hash: str
    training_config: dict[str, Any] = field(default_factory=dict)
    parent_artifact_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "artifact_type": self.artifact_type.value,
            "model_family": self.model_family,
            "model_version": self.model_version,
            "provider": self.provider,
            "storage_uri": self.storage_uri,
            "config_hash": self.config_hash,
            "training_config": self.training_config,
            "parent_artifact_id": self.parent_artifact_id,
            "created_at": self.created_at.isoformat(),
            "metadata": self.metadata,
        }


@dataclass
class ArtifactEvaluation:
    evaluation_id: str
    artifact_id: str
    benchmark_suite_id: str
    pass_rate: float
    avg_latency_ms: int
    cost_per_1k_tokens: float
    hallucination_rate: float
    evaluated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        return {
            "evaluation_id": self.evaluation_id,
            "artifact_id": self.artifact_id,
            "benchmark_suite_id": self.benchmark_suite_id,
            "pass_rate": self.pass_rate,
            "avg_latency_ms": self.avg_latency_ms,
            "cost_per_1k_tokens": self.cost_per_1k_tokens,
            "hallucination_rate": self.hallucination_rate,
            "evaluated_at": self.evaluated_at.isoformat(),
        }


class ModelArtifactRegistry:
    """In-memory model artifact registry with evaluation linkage.

    Production would persist to PostgreSQL + S3.
    """

    def __init__(self):
        self._artifacts: dict[str, ModelArtifact] = {}
        self._evaluations: dict[str, list[ArtifactEvaluation]] = {}
        self._family_index: dict[str, list[str]] = {}

    def register(self, artifact: ModelArtifact) -> ModelArtifact:
        self._artifacts[artifact.artifact_id] = artifact
        self._family_index.setdefault(artifact.model_family, []).append(artifact.artifact_id)
        return artifact

    def get(self, artifact_id: str) -> ModelArtifact | None:
        return self._artifacts.get(artifact_id)

    def list_by_family(self, model_family: str) -> list[ModelArtifact]:
        ids = self._family_index.get(model_family, [])
        return [self._artifacts[i] for i in ids if i in self._artifacts]

    def list_all(self, artifact_type: ArtifactType | None = None) -> list[ModelArtifact]:
        artifacts = list(self._artifacts.values())
        if artifact_type:
            artifacts = [a for a in artifacts if a.artifact_type == artifact_type]
        return sorted(artifacts, key=lambda a: a.created_at, reverse=True)

    def add_evaluation(self, evaluation: ArtifactEvaluation) -> None:
        self._evaluations.setdefault(evaluation.artifact_id, []).append(evaluation)

    def get_evaluations(self, artifact_id: str) -> list[ArtifactEvaluation]:
        return sorted(
            self._evaluations.get(artifact_id, []),
            key=lambda e: e.evaluated_at,
            reverse=True,
        )

    def compute_config_hash(self, config: dict[str, Any]) -> str:
        canonical = json.dumps(config, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()[:32]

    def resolve_model(self, model_family: str, model_version: str) -> ModelArtifact | None:
        for artifact in self._artifacts.values():
            if artifact.model_family == model_family and artifact.model_version == model_version:
                return artifact
        return None

    def get_best_by_metric(
        self,
        model_family: str,
        metric: str = "pass_rate",
        min_evaluations: int = 1,
    ) -> ModelArtifact | None:
        candidates = self.list_by_family(model_family)
        scored: list[tuple[ModelArtifact, float]] = []
        for artifact in candidates:
            evals = self.get_evaluations(artifact.artifact_id)
            if len(evals) < min_evaluations:
                continue
            if metric == "pass_rate":
                score = sum(e.pass_rate for e in evals) / len(evals)
            elif metric == "cost_per_1k_tokens":
                score = sum(e.cost_per_1k_tokens for e in evals) / len(evals)
            elif metric == "avg_latency_ms":
                score = sum(e.avg_latency_ms for e in evals) / len(evals)
            else:
                score = 0.0
            scored.append((artifact, score))
        if not scored:
            return None
        if metric == "cost_per_1k_tokens":
            scored.sort(key=lambda x: x[1])  # lower is better
        else:
            scored.sort(key=lambda x: x[1], reverse=True)
        return scored[0][0]

    # ─────────────────────────────────────────────────────────────────────
    # Phase 6.7.1: PostgreSQL persistence
    # ─────────────────────────────────────────────────────────────────────
    # The in-memory registry is the hot path. On every mutation we
    # also write to PostgreSQL so a process restart recovers state
    # and so multiple API replicas share the same view. Storage
    # failures are logged but never block the in-memory update.

    async def persist_artifact(self, artifact: ModelArtifact) -> bool:
        """Write ``artifact`` to the ``model_artifacts`` table."""
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            await client.execute(
                """
                INSERT INTO model_artifacts (
                    id, model_family, model_version, artifact_type,
                    storage_uri, config_hash, parent_artifact_id,
                    training_config, created_by, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (id) DO UPDATE SET
                    model_family = EXCLUDED.model_family,
                    model_version = EXCLUDED.model_version,
                    storage_uri = EXCLUDED.storage_uri,
                    config_hash = EXCLUDED.config_hash
                """,
                artifact.artifact_id,
                artifact.model_family,
                artifact.model_version,
                artifact.artifact_type.value,
                artifact.storage_uri,
                artifact.config_hash,
                artifact.parent_artifact_id,
                json.dumps(artifact.training_config),
                artifact.created_by,
                artifact.created_at,
            )
            return True
        except Exception as exc:
            logger.warning(f"Failed to persist model artifact {artifact.artifact_id}: {exc}")
            return False

    async def persist_evaluation(self, evaluation: ArtifactEvaluation) -> bool:
        """Write ``evaluation`` to the ``model_evaluations`` table."""
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            await client.execute(
                """
                INSERT INTO model_evaluations (
                    id, artifact_id, eval_name, pass_rate,
                    cost_per_1k_tokens, avg_latency_ms, dataset_id,
                    metadata, evaluated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                """,
                evaluation.eval_id,
                evaluation.artifact_id,
                evaluation.eval_name,
                evaluation.pass_rate,
                evaluation.cost_per_1k_tokens,
                evaluation.avg_latency_ms,
                evaluation.dataset_id,
                json.dumps(evaluation.metadata),
                evaluation.evaluated_at,
            )
            return True
        except Exception as exc:
            logger.warning(f"Failed to persist evaluation {evaluation.eval_id}: {exc}")
            return False

    async def load_all(self) -> int:
        """Hydrate the in-memory registry from PostgreSQL.

        Call once at startup so a fresh process recovers persisted
        state. Returns the number of artifacts loaded.
        """
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            rows = await client.fetch(
                """
                SELECT id, model_family, model_version, artifact_type,
                       storage_uri, config_hash, parent_artifact_id,
                       training_config, created_by, created_at
                FROM model_artifacts
                ORDER BY created_at DESC
                """
            )
            for r in rows:
                artifact = ModelArtifact(
                    artifact_id=r["id"],
                    model_family=r["model_family"],
                    model_version=r["model_version"],
                    artifact_type=ArtifactType(r["artifact_type"]),
                    storage_uri=r["storage_uri"] or "",
                    config_hash=r["config_hash"] or "",
                    parent_artifact_id=r["parent_artifact_id"],
                    training_config=r["training_config"] or {},
                    created_by=r["created_by"] or "system",
                    created_at=r["created_at"],
                )
                self._artifacts[artifact.artifact_id] = artifact
            return len(rows)
        except Exception as exc:
            logger.warning(f"Failed to load model artifacts from DB: {exc}")
            return 0

    async def register_persisted(
        self, artifact: ModelArtifact
    ) -> ModelArtifact:
        """Register and persist. Convenience wrapper."""
        result = self.register(artifact)
        await self.persist_artifact(artifact)
        return result
