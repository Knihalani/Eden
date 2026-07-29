"""F21 — ToolCallCalibrator: train/predict on label feature vectors."""

from __future__ import annotations

import json
import logging
import math
import pickle
import uuid
from typing import Any

logger = logging.getLogger(__name__)


class ToolCallCalibrator:
    """Tiny logistic regression over bag-of-hash features (no sklearn required)."""

    def __init__(self, weights: list[float] | None = None, bias: float = 0.0) -> None:
        self.weights = weights or [0.0] * 16
        self.bias = bias
        self.sample_count = 0
        self.precision: float | None = None
        self.recall: float | None = None

    def train(
        self, rows: list[tuple[list[float], int]], *, epochs: int = 40, lr: float = 0.15
    ) -> dict[str, Any]:
        if len(rows) < 2:
            return {"status": "insufficient_samples", "sample_count": len(rows)}
        dim = len(rows[0][0])
        w = [0.0] * dim
        b = 0.0
        for _ in range(epochs):
            for x, y in rows:
                z = b + sum(wi * xi for wi, xi in zip(w, x, strict=False))
                p = 1.0 / (1.0 + math.exp(-max(-20.0, min(20.0, z))))
                err = p - float(y)
                for i in range(dim):
                    w[i] -= lr * err * x[i]
                b -= lr * err
        self.weights = w
        self.bias = b
        self.sample_count = len(rows)
        metrics = self._holdout_metrics(rows)
        self.precision = metrics["precision"]
        self.recall = metrics["recall"]
        return {
            "status": "ok",
            "sample_count": self.sample_count,
            "precision": self.precision,
            "recall": self.recall,
        }

    def predict_proba(self, features: list[float]) -> float:
        z = self.bias + sum(
            wi * xi for wi, xi in zip(self.weights, features, strict=False)
        )
        return 1.0 / (1.0 + math.exp(-max(-20.0, min(20.0, z))))

    def predict(self, features: list[float], *, threshold: float = 0.85) -> dict[str, Any]:
        conf = self.predict_proba(features)
        label = "bad" if conf >= threshold else "good"
        return {
            "predicted_label": label,
            "confidence": conf,
            "threshold": threshold,
        }

    def dumps(self) -> bytes:
        return pickle.dumps(
            {
                "weights": self.weights,
                "bias": self.bias,
                "sample_count": self.sample_count,
                "precision": self.precision,
                "recall": self.recall,
            }
        )

    @classmethod
    def loads(cls, blob: bytes) -> ToolCallCalibrator:
        data = pickle.loads(blob)  # noqa: S301 — internal model blob
        cal = cls(weights=list(data.get("weights") or []), bias=float(data.get("bias") or 0.0))
        cal.sample_count = int(data.get("sample_count") or 0)
        cal.precision = data.get("precision")
        cal.recall = data.get("recall")
        return cal

    def _holdout_metrics(self, rows: list[tuple[list[float], int]]) -> dict[str, float]:
        tp = fp = fn = 0
        for x, y in rows:
            pred = 1 if self.predict_proba(x) >= 0.5 else 0
            if pred == 1 and y == 1:
                tp += 1
            elif pred == 1 and y == 0:
                fp += 1
            elif pred == 0 and y == 1:
                fn += 1
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        return {"precision": precision, "recall": recall}


async def train_and_persist(
    org_id: str,
    agent_id: str,
    tool_name: str,
) -> dict[str, Any]:
    from eden.learning.tool_call_labels import ToolCallLabelService

    svc = ToolCallLabelService()
    rows = await svc.export_training_rows(org_id, agent_id, tool_name)
    if len(rows) < 5:
        return {
            "status": "insufficient_labels",
            "sample_count": len(rows),
            "min_required": 5,
        }
    cal = ToolCallCalibrator()
    metrics = cal.train(rows)
    if metrics.get("status") != "ok":
        return metrics

    try:
        from eden.config import get_settings

        if not bool(getattr(get_settings(), "tool_call_inference_v1", False)):
            return {**metrics, "persisted": False, "reason": "tool_call_inference_v1_off"}
    except Exception:
        pass

    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception as exc:
        return {**metrics, "persisted": False, "error": str(exc)}
    if pg is None:
        return {**metrics, "persisted": False, "error": "database unavailable"}

    cal_id = str(uuid.uuid4())
    blob = cal.dumps()
    await pg.execute(
        """
        INSERT INTO tool_call_calibrators
            (id, org_id, agent_id, tool_name, model_blob, precision, recall, sample_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (org_id, agent_id, tool_name) DO UPDATE SET
            model_blob = EXCLUDED.model_blob,
            precision = EXCLUDED.precision,
            recall = EXCLUDED.recall,
            sample_count = EXCLUDED.sample_count,
            trained_at = now()
        """,
        cal_id,
        org_id,
        agent_id,
        tool_name,
        blob,
        cal.precision,
        cal.recall,
        cal.sample_count,
    )
    return {
        **metrics,
        "persisted": True,
        "calibrator_id": cal_id,
        "org_id": org_id,
        "agent_id": agent_id,
        "tool_name": tool_name,
    }


async def list_calibrators(org_id: str, agent_id: str) -> list[dict[str, Any]]:
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return []
    if pg is None:
        return []
    rows = await pg.fetch(
        """
        SELECT id, agent_id, tool_name, precision, recall, sample_count, trained_at
        FROM tool_call_calibrators
        WHERE org_id = $1 AND agent_id = $2
        ORDER BY trained_at DESC
        LIMIT 100
        """,
        org_id,
        agent_id,
    )
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        for k, v in list(d.items()):
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
            elif isinstance(v, (bytes, memoryview)):
                d[k] = f"<{len(bytes(v))} bytes>"
        out.append(d)
    return out


async def infer_tool_misuse(
    org_id: str,
    agent_id: str,
    tool_name: str,
    args_summary: str,
    *,
    span_id: str | None = None,
) -> dict[str, Any] | None:
    """Run calibrator inference; return prediction dict or None when cold/disabled."""
    try:
        from eden.config import get_settings

        if not bool(getattr(get_settings(), "tool_call_inference_v1", False)):
            return None
    except Exception:
        return None

    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return None
    if pg is None:
        return None

    row = await pg.fetchrow(
        """
        SELECT id, model_blob, precision
        FROM tool_call_calibrators
        WHERE org_id = $1 AND agent_id = $2 AND tool_name = $3
        """,
        org_id,
        agent_id,
        tool_name,
    )
    if not row or not row.get("model_blob"):
        return None
    if row.get("precision") is not None and float(row["precision"]) < 0.6:
        return {"skipped": True, "reason": "precision_below_floor"}

    from eden.learning.tool_call_labels import ToolCallLabelService

    features = ToolCallLabelService().feature_vector(tool_name, args_summary, agent_id)
    cal = ToolCallCalibrator.loads(bytes(row["model_blob"]))
    pred = cal.predict(features)
    pred["calibrator_id"] = str(row["id"])
    pred["span_id"] = span_id
    return pred


def serialize_metrics(metrics: dict[str, Any]) -> str:
    return json.dumps(metrics, default=str)
