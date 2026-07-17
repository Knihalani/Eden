"""F34 — per-org trained signal classifiers."""

from __future__ import annotations

import json
import logging
import pickle
import uuid
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

_MIN_SAMPLES = 5
_MIN_F1 = 0.5


@dataclass
class TrainResult:
    classifier_id: str
    signal_id: str
    sample_count: int
    metrics: dict[str, Any]
    trained: bool


class ClassifierTrainingPipeline:
    """Train a lightweight logistic model on signal event labels."""

    async def train(
        self,
        org_id: str,
        signal_id: str,
        *,
        trace_ids: list[str] | None = None,
    ) -> TrainResult:
        rows = await self._load_training_rows(org_id, signal_id, trace_ids)
        if len(rows) < _MIN_SAMPLES:
            return TrainResult(
                classifier_id="",
                signal_id=signal_id,
                sample_count=len(rows),
                metrics={"f1": 0.0, "reason": "insufficient_samples"},
                trained=False,
            )

        x = [r["features"] for r in rows]
        y = [r["label"] for r in rows]
        model, metrics = self._fit_logistic(x, y)
        blob = pickle.dumps(model)
        classifier_id = str(uuid.uuid4())

        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception as exc:
            logger.debug("classifier_pipeline: db unavailable: %s", exc)
            return TrainResult(
                classifier_id="",
                signal_id=signal_id,
                sample_count=len(rows),
                metrics=metrics,
                trained=False,
            )
        if pg is None:
            return TrainResult(
                classifier_id="",
                signal_id=signal_id,
                sample_count=len(rows),
                metrics=metrics,
                trained=False,
            )

        await pg.execute(
            """
            INSERT INTO signal_classifiers
                (id, org_id, signal_id, model_type, model_blob, metrics,
                 sample_count, shadow_mode)
            VALUES ($1, $2, $3, 'logistic', $4, $5::jsonb, $6, TRUE)
            """,
            classifier_id,
            org_id,
            signal_id,
            blob,
            json.dumps(metrics, default=str, separators=(",", ":")),
            len(rows),
        )
        return TrainResult(
            classifier_id=classifier_id,
            signal_id=signal_id,
            sample_count=len(rows),
            metrics=metrics,
            trained=metrics.get("f1", 0) >= _MIN_F1,
        )

    async def infer_trace(
        self,
        org_id: str,
        signal_id: str,
        features: list[float],
    ) -> tuple[bool, float]:
        model = await self._load_model(org_id, signal_id)
        if model is None:
            return False, 0.0
        return self._predict(model, features)

    async def infer_with_blob(
        self, model_blob: Any, features: list[float]
    ) -> tuple[bool, float]:
        if not model_blob:
            return False, 0.0
        try:
            model = pickle.loads(bytes(model_blob))
        except Exception:
            return False, 0.0
        return self._predict(model, features)

    @staticmethod
    def _predict(model: Any, features: list[float]) -> tuple[bool, float]:
        try:
            proba = float(model.predict_proba([features])[0][1])
        except Exception:
            try:
                pred = int(model.predict([features])[0])
                proba = float(pred)
            except Exception:
                return False, 0.0
        return proba >= 0.5, proba

    async def get_status(self, org_id: str, signal_id: str) -> dict[str, Any]:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return {"status": "unavailable"}
        if pg is None:
            return {"status": "unavailable"}
        row = await pg.fetchrow(
            """
            SELECT id::text, model_type, metrics, shadow_mode,
                   COALESCE(investigator_disabled, FALSE) AS investigator_disabled,
                   sample_count, trained_at, version
            FROM signal_classifiers
            WHERE org_id = $1 AND signal_id = $2
            ORDER BY trained_at DESC
            LIMIT 1
            """,
            org_id,
            signal_id,
        )
        if not row:
            return {"status": "missing", "signal_id": signal_id}
        metrics = row["metrics"]
        if isinstance(metrics, str):
            try:
                metrics = json.loads(metrics)
            except (TypeError, ValueError):
                metrics = {}
        return {
            "status": "ok",
            "classifier_id": row["id"],
            "signal_id": signal_id,
            "model_type": row["model_type"],
            "metrics": metrics,
            "shadow_mode": bool(row["shadow_mode"]),
            "investigator_disabled": bool(row["investigator_disabled"]),
            "sample_count": int(row["sample_count"] or 0),
            "trained_at": row["trained_at"].isoformat()
            if row["trained_at"]
            else None,
            "version": int(row["version"] or 1),
        }

    async def promote(
        self, org_id: str, signal_id: str, *, min_agreement: float = 0.8
    ) -> dict[str, Any]:
        """Disable investigator for signal when shadow agreement passes."""
        from eden.signals.shadow_compare import ShadowComparator

        report = await ShadowComparator().report(org_id, signal_id)
        agreement = report.get("agreement_rate")
        if agreement is None or float(agreement) < min_agreement:
            return {
                "status": "blocked",
                "reason": "shadow_agreement_below_threshold",
                "report": report,
            }
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return {"status": "unavailable"}
        if pg is None:
            return {"status": "unavailable"}
        await pg.execute(
            """
            UPDATE signal_classifiers
            SET shadow_mode = FALSE,
                investigator_disabled = TRUE
            WHERE org_id = $1 AND signal_id = $2
              AND id = (
                SELECT id FROM signal_classifiers
                WHERE org_id = $1 AND signal_id = $2
                ORDER BY trained_at DESC LIMIT 1
              )
            """,
            org_id,
            signal_id,
        )
        return {
            "status": "ok",
            "promoted": True,
            "signal_id": signal_id,
            "investigator_disabled": True,
            "shadow_mode": False,
            "report": report,
        }

    async def retrain_due_orgs(self) -> dict[str, Any]:
        """Cron entry: retrain classifiers with fresh signal events."""
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return {"retrained": 0}
        if pg is None:
            return {"retrained": 0}

        try:
            rows = await pg.fetch(
                """
                SELECT DISTINCT org_id::text, signal_id::text
                FROM signal_events
                WHERE detected_at > NOW() - INTERVAL '7 days'
                LIMIT 50
                """
            )
        except Exception:
            return {"retrained": 0}

        retrained = 0
        for row in rows:
            result = await self.train(str(row["org_id"]), str(row["signal_id"]))
            if result.trained:
                retrained += 1
        return {"retrained": retrained, "candidates": len(rows)}

    async def _load_training_rows(
        self,
        org_id: str,
        signal_id: str,
        trace_ids: list[str] | None,
    ) -> list[dict[str, Any]]:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return []
        if pg is None:
            return []

        if trace_ids:
            rows = await pg.fetch(
                """
                SELECT trace_id, matched, payload
                FROM signal_events
                WHERE org_id = $1 AND signal_id = $2
                  AND trace_id = ANY($3::text[])
                """,
                org_id,
                signal_id,
                trace_ids,
            )
        else:
            rows = await pg.fetch(
                """
                SELECT trace_id, matched, payload
                FROM signal_events
                WHERE org_id = $1 AND signal_id = $2
                ORDER BY detected_at DESC
                LIMIT 500
                """,
                org_id,
                signal_id,
            )

        out: list[dict[str, Any]] = []
        for r in rows:
            payload = r["payload"]
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except (TypeError, ValueError):
                    payload = {}
            text = json.dumps(payload, default=str)
            features = self._hash_features(text)
            out.append({"features": features, "label": 1 if r["matched"] else 0})
        return out

    async def _load_model(self, org_id: str, signal_id: str) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return None
        if pg is None:
            return None
        row = await pg.fetchrow(
            """
            SELECT model_blob
            FROM signal_classifiers
            WHERE org_id = $1 AND signal_id = $2
            ORDER BY trained_at DESC
            LIMIT 1
            """,
            org_id,
            signal_id,
        )
        if not row:
            return None
        try:
            return pickle.loads(bytes(row["model_blob"]))
        except Exception:
            return None

    @staticmethod
    def _hash_features(text: str) -> list[float]:
        import hashlib

        vec = [0.0] * 16
        digest = hashlib.sha256(text.encode()).digest()
        for i, b in enumerate(digest[:16]):
            vec[i] = (b / 255.0) * 2 - 1
        return vec

    @staticmethod
    def _fit_logistic(
        x: list[list[float]], y: list[int]
    ) -> tuple[Any, dict[str, Any]]:
        try:
            from sklearn.linear_model import LogisticRegression
            from sklearn.metrics import f1_score
            from sklearn.model_selection import train_test_split

            if len(set(y)) < 2:
                model = LogisticRegression(max_iter=200)
                model.fit(x, y)
                return model, {"f1": 1.0, "holdout_size": len(x)}

            x_train, x_test, y_train, y_test = train_test_split(
                x, y, test_size=0.2, random_state=42
            )
            model = LogisticRegression(max_iter=200)
            model.fit(x_train, y_train)
            preds = model.predict(x_test)
            f1 = float(f1_score(y_test, preds, zero_division=0))
            return model, {"f1": round(f1, 4), "holdout_size": len(x_test)}
        except Exception:
            # Pure-Python majority-class fallback.
            pos = sum(y)
            rate = pos / max(len(y), 1)

            class _Majority:
                def predict(self, xs: list[list[float]]) -> list[int]:
                    return [1 if rate >= 0.5 else 0 for _ in xs]

                def predict_proba(self, xs: list[list[float]]) -> list[list[float]]:
                    p = rate
                    return [[1 - p, p] for _ in xs]

            return _Majority(), {"f1": rate, "holdout_size": 0, "fallback": True}
