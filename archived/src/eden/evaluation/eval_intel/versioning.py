"""Eval versioning services (Cat 3) — real implementations.

Two services:

* :class:`EvalVersioner` — bind judge scores to a deployment
  SHA + prompt version. Detects regressions vs. the previous
  active version by comparing the new version's judges' mean
  score in the last 7 days vs. the previous version's
  same-window mean. Fires
  :func:`eden.llmops.promotion_hooks.PromotionHook.on_judge_regression`
  when a regression is detected (Galileo eval-to-guardrail
  lifecycle's "block promotion on judge regression" hook).

* :class:`EvalRegistry` — list all eval versions for an org,
  newest first. Decodes the ``judge_set_json`` column into a
  Python list so the front-end can render the judge set
  without a second round-trip.

Both services degrade gracefully:

* No Postgres client → in-memory response, no persistence.
* No previous active version → no regression detection.
* < 5 samples for the new version → no regression detection
  (not enough signal).

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ._common import (
    REGRESSION_LOOKBACK_DAYS,
    REGRESSION_MATERIALITY,
    REGRESSION_MIN_SAMPLES,
    _bad_request_envelope,
    _delete_then_insert_version,
    _fetch_eval_version_by_sha,
    _fetch_eval_versions,
    _fetch_judge_scores_for_window,
    _fetch_previous_active_eval_version,
    _fire_eval_version_regression,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


# ── 1. EvalVersioner ────────────────────────────────────────────────


class EvalVersioner:
    """Tag a deployment SHA + prompt version with a judge set.

    Idempotent: re-tagging the same ``(org_id, deployment_sha)``
    replaces the previous row.

    The :attr:`name` is ``"eval_versioner"``. Public method
    :meth:`tag` returns the live envelope on success, or a
    live "bad_request" envelope on validation failure.
    """

    name = "eval_versioner"

    async def tag(
        self,
        org_id: str,
        *,
        deployment_sha: str,
        prompt_version: str,
        judge_set: list[str],
    ) -> dict[str, Any]:
        # 1. Validate inputs.
        if (
            not deployment_sha
            or not isinstance(deployment_sha, str)
            or not (7 <= len(deployment_sha.strip()) <= 64)
        ):
            return _bad_request_envelope(
                self.name,
                "deployment_sha must be 7-64 chars",
            )
        if not prompt_version or not isinstance(prompt_version, str):
            return _bad_request_envelope(
                self.name,
                "prompt_version must be a non-empty string",
            )
        if not isinstance(judge_set, list) or not judge_set:
            return _bad_request_envelope(
                self.name,
                "judge_set must be a non-empty list of judge names",
            )
        judge_set = [str(j).strip() for j in judge_set if j]
        if not judge_set:
            return _bad_request_envelope(
                self.name,
                "judge_set must contain at least one non-empty string",
            )
        deployment_sha = deployment_sha.strip()
        prompt_version = prompt_version.strip()[:64]

        # 2. Persist (best-effort, delete-then-insert).
        judge_set_json = json.dumps(judge_set)
        await _delete_then_insert_version(
            org_id,
            deployment_sha,
            prompt_version=prompt_version,
            judge_set_json=judge_set_json,
            status="active",
        )

        # 3. Regression detection: compare the new version's
        # judges' mean score in the last REGRESSION_LOOKBACK_DAYS
        # days vs. the previous active version's same-window
        # mean. A drop > REGRESSION_MATERIALITY fires the hook.
        regression_detected = False
        previous_avg: float | None = None
        current_avg: float | None = None
        regressed_judges: list[str] = []

        interval = f"{REGRESSION_LOOKBACK_DAYS} days"
        current_samples: dict[str, list[float]] = {j: [] for j in judge_set}
        for j in judge_set:
            rows = await _fetch_judge_scores_for_window(
                org_id, j, interval,
            )
            current_samples[j] = [
                float(r.get("score", 0.0) or 0.0) for r in rows
            ]

        # The "previous version" is the most recent active
        # eval_versions row with a different deployment_sha.
        previous_version = await _fetch_previous_active_eval_version(
            org_id, deployment_sha,
        )
        if previous_version is not None:
            prev_judge_set = previous_version.get("judge_set") or []
            prev_samples: dict[str, list[float]] = {
                j: [] for j in prev_judge_set
            }
            for j in prev_judge_set:
                rows = await _fetch_judge_scores_for_window(
                    org_id, j, interval,
                )
                prev_samples[j] = [
                    float(r.get("score", 0.0) or 0.0) for r in rows
                ]
            # Compare judge-by-judge (intersection).
            overlapping = set(judge_set) & set(prev_judge_set)
            drops: list[tuple[str, float, float]] = []
            for j in overlapping:
                cur = current_samples.get(j, [])
                prv = prev_samples.get(j, [])
                if (
                    len(cur) >= REGRESSION_MIN_SAMPLES
                    and len(prv) >= REGRESSION_MIN_SAMPLES
                ):
                    c = sum(cur) / len(cur)
                    p = sum(prv) / len(prv)
                    if p - c > REGRESSION_MATERIALITY:
                        drops.append((j, p, c))
            if drops:
                regression_detected = True
                regressed_judges = [d[0] for d in drops]
                previous_avg = sum(d[1] for d in drops) / len(drops)
                current_avg = sum(d[2] for d in drops) / len(drops)

        # 4. Fire the closed-loop hook on regression. Best-effort.
        if regression_detected:
            for j, _, _c in [
                (j, 0.0, 0.0) for j in regressed_judges
            ]:
                _fire_eval_version_regression(
                    org_id,
                    deployment_sha=deployment_sha,
                    judge_name=j,
                    score=float(current_samples.get(j, [0.0])[0])
                    if current_samples.get(j) else 0.0,
                )

        # 5. Re-fetch to surface the canonical row id + timestamp.
        row = await _fetch_eval_version_by_sha(org_id, deployment_sha)
        eval_version_id = str(row.get("id")) if row else None

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "eval_version_id": eval_version_id,
                "deployment_sha": deployment_sha,
                "prompt_version": prompt_version,
                "judge_set": judge_set,
                "status": "active",
                "regression_detected": regression_detected,
                "regressed_judges": regressed_judges,
                "previous_avg_score": (
                    round(previous_avg, 4)
                    if previous_avg is not None else None
                ),
                "current_avg_score": (
                    round(current_avg, 4)
                    if current_avg is not None else None
                ),
            },
        )


# ── 2. EvalRegistry ─────────────────────────────────────────────────


class EvalRegistry:
    """List all eval versions for an org, newest first.

    The :attr:`name` is ``"eval_registry"``. Public method
    :meth:`list` returns the live envelope on success.
    """

    name = "eval_registry"

    async def list(
        self,
        org_id: str,
    ) -> dict[str, Any]:
        rows = await _fetch_eval_versions(org_id)
        if not rows:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "versions": [],
                    "count": 0,
                    "message": "no eval versions",
                },
            )

        # Build the response. Decoding judge_set from JSON is
        # already done in _fetch_eval_versions.
        versions: list[dict[str, Any]] = []
        for r in rows:
            versions.append(
                {
                    "id": str(r.get("id", "")) if r.get("id") is not None else None,
                    "deployment_sha": r.get("deployment_sha"),
                    "prompt_version": r.get("prompt_version"),
                    "judge_set": r.get("judge_set", []),
                    "status": r.get("status"),
                    "created_at": (
                        r["created_at"].isoformat()
                        if hasattr(r.get("created_at"), "isoformat")
                        else str(r.get("created_at"))
                    ),
                }
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "versions": versions,
                "count": len(versions),
            },
        )
