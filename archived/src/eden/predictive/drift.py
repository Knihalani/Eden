"""Cat 13 — DriftDetector.

Output and embedding drift detection (Phoenix / Datadog
parity). The headline Cat 13 service from the spec:

    "distribution-level shift in judge scores between
    baseline and current window"
    "distribution-level shift in the response embeddings
    (catches topic drift the judges might miss)"

Algorithm: Population Stability Index (PSI) on bucketed
samples. PSI is the industry standard for distribution
shift; the threshold convention is:

* < 0.1 = no shift
* 0.1..0.2 = small shift (warning)
* > 0.2 = significant shift (high)

Output drift: judge scores in the baseline window
(``7 days``) vs the current window (``24 hours``).

Embedding drift: the response ``response_body`` text is
hashed into :data:`EMBEDDING_BUCKETS` (64) buckets using
:func:`eden.predictive._common._hash_bucket`. The PSI is
computed on the bucket histograms of the baseline vs
current windows. This is a *content-only* topic-drift
proxy — a true production system would use a learned
embedding model; the v1 ship uses a stable hash so the
computation is O(1) and dependency-free.

Each detected drift is persisted to ``drift_alerts`` and
the high-severity ones fire
:func:`PromotionHook.on_drift_alert` via
:func:`eden.predictive._common._fire_drift_alert`. Mirrors
the Cat 2 + Cat 8 pattern.

See ``docs/observability-gap/13-predictive-intelligence.md``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from ._common import (
    EMBEDDING_BUCKETS,
    PSI_BUCKETS,
    PSI_THRESHOLD,
    _fetch_recent_judge_scores,
    _fetch_response_text_samples,
    _fire_drift_alert,
    _hash_bucket,
    _insert_drift_alert,
    _ok_envelope,
    _parse_window,
    _psi,
    _safe_float,
    _with_pg_assumptions,
)

logger = logging.getLogger(__name__)


#: Identifies the algorithm in the response ``data.model``.
MODEL_NAME: str = "psi_v1"

#: Baseline window for the output-drift detector. The spec
#: calls out "7 days" as the canonical baseline.
OUTPUT_BASELINE_DAYS: int = 7

#: Current window for the output-drift detector. The spec
#: calls out "24 hours" as the canonical "now" window.
OUTPUT_CURRENT_HOURS: int = 24

#: Baseline / current windows for the embedding-drift
#: detector. Same shape as the output detector but the
#: sample limit is lower (200 rows per window) to keep the
#: read cheap.
EMBEDDING_BASELINE_DAYS: int = 7
EMBEDDING_CURRENT_HOURS: int = 24
EMBEDDING_SAMPLE_LIMIT: int = 200

#: PSI severity thresholds. Mirrors the industry rule of
#: thumb. ``high`` fires the closed-loop hook; ``warning``
#: is persisted but doesn't fire.
PSI_WARN: float = 0.1
PSI_HIGH: float = PSI_THRESHOLD


class DriftDetector:
    """Output + embedding drift detection (Phoenix / Datadog)."""

    name = "drift_detector"

    async def detect_output_drift(
        self,
        org_id: str,
        *,
        window: str = "24h",
    ) -> dict[str, Any]:
        """Detect output drift (judge-score distribution
        shift) between the baseline 7-day window and the
        current ``window``.

        Args:
            org_id: The tenant id.
            window: The "current" window string. Accepts
                ``"Nh"`` / ``"Nd"`` / ``"Nm"`` / ``"Ns"``.
                Default ``"24h"``.

        Returns:
            The live envelope with ``psi_value``,
            ``severity`` (no_shift | warning | high), and
            the per-bucket histograms.
        """
        interval_sql = _parse_window(window)
        if interval_sql is None:
            return _ok_envelope(
                self.name,
                {
                    "drift_type": "output",
                    "severity": "bad_request",
                    "message": (
                        f"invalid window: {window!r} "
                        "(expected one of: Nh, Nd, Nm, Ns)"
                    ),
                },
            )

        # Baseline + current windows are independent reads; run them
        # concurrently via asyncio.gather to cut per-detector
        # wall-clock latency in half on this hot path.
        baseline_rows, current_rows = await asyncio.gather(
            _fetch_recent_judge_scores(org_id, f"{OUTPUT_BASELINE_DAYS} days"),
            _fetch_recent_judge_scores(org_id, interval_sql),
        )
        baseline_scores = [_safe_float(r.get("score")) for r in baseline_rows]
        current_scores = [_safe_float(r.get("score")) for r in current_rows]

        psi_value, base_pct, curr_pct = _psi(
            baseline_scores, current_scores, n_buckets=PSI_BUCKETS,
        )
        severity = _severity_for_psi(psi_value)

        details = {
            "baseline_window": f"{OUTPUT_BASELINE_DAYS} days",
            "current_window": interval_sql,
            "baseline_samples": len(baseline_scores),
            "current_samples": len(current_scores),
            "buckets": PSI_BUCKETS,
            "baseline_histogram_pct": base_pct,
            "current_histogram_pct": curr_pct,
        }
        details_json = json.dumps(details)
        # Append (don't replace) drift alerts — the table
        # is an event log.
        await _insert_drift_alert(
            org_id,
            drift_type="output_drift",
            severity=severity,
            baseline_value=None,
            current_value=psi_value,
            details_json=details_json,
        )
        # Fire the closed-loop hook for high-severity
        # drift. Mirrors the Cat 2 + Cat 8 pattern.
        _fire_drift_alert(
            org_id,
            drift_type="output_drift",
            severity=severity,
            details=details,
        )
        return _ok_envelope(
            self.name,
            {
                "drift_type": "output",
                "org_id": org_id,
                "psi_value": psi_value,
                "severity": severity,
                "details": details,
                "model": MODEL_NAME,
            },
        )

    async def detect_embedding_drift(
        self,
        org_id: str,
        *,
        window: str = "24h",
    ) -> dict[str, Any]:
        """Detect embedding / topic drift between the
        baseline 7-day window and the current ``window``.

        Args:
            org_id: The tenant id.
            window: The "current" window string. Accepts
                ``"Nh"`` / ``"Nd"`` / ``"Nm"`` / ``"Ns"``.
                Default ``"24h"``.

        Returns:
            The live envelope with ``psi_value``,
            ``severity`` (no_shift | warning | high), and
            the per-bucket histograms. The ``buckets`` is
            the number of hash buckets (default 64).
        """
        interval_sql = _parse_window(window)
        if interval_sql is None:
            return _ok_envelope(
                self.name,
                {
                    "drift_type": "embedding",
                    "severity": "bad_request",
                    "message": (
                        f"invalid window: {window!r} "
                        "(expected one of: Nh, Nd, Nm, Ns)"
                    ),
                },
            )

        # Same concurrent-fetch pattern as the output-drift detector above.
        baseline_texts, current_texts = await asyncio.gather(
            _fetch_response_text_samples(
                org_id, f"{EMBEDDING_BASELINE_DAYS} days",
                limit=EMBEDDING_SAMPLE_LIMIT,
            ),
            _fetch_response_text_samples(
                org_id, interval_sql, limit=EMBEDDING_SAMPLE_LIMIT,
            ),
        )
        # Hash each text into a bucket index, then expand
        # into a per-bucket "1.0" sample (so the PSI sees
        # them as data points). This is the standard way
        # to apply PSI on a categorical / hash signal.
        baseline_buckets = [
            float(_hash_bucket(t, EMBEDDING_BUCKETS)) for t in baseline_texts
        ]
        current_buckets = [
            float(_hash_bucket(t, EMBEDDING_BUCKETS)) for t in current_texts
        ]
        psi_value, base_pct, curr_pct = _psi(
            baseline_buckets, current_buckets, n_buckets=EMBEDDING_BUCKETS,
        )
        severity = _severity_for_psi(psi_value)

        details = {
            "baseline_window": f"{EMBEDDING_BASELINE_DAYS} days",
            "current_window": interval_sql,
            "baseline_samples": len(baseline_texts),
            "current_samples": len(current_texts),
            "buckets": EMBEDDING_BUCKETS,
            "baseline_histogram_pct": base_pct,
            "current_histogram_pct": curr_pct,
        }
        details_json = json.dumps(details)
        await _insert_drift_alert(
            org_id,
            drift_type="embedding_drift",
            severity=severity,
            baseline_value=None,
            current_value=psi_value,
            details_json=details_json,
        )
        _fire_drift_alert(
            org_id,
            drift_type="embedding_drift",
            severity=severity,
            details=details,
        )
        return _ok_envelope(
            self.name,
            _with_pg_assumptions(
                {
                    "drift_type": "embedding",
                    "org_id": org_id,
                    "psi_value": psi_value,
                    "severity": severity,
                    "details": details,
                    "model": MODEL_NAME,
                }
            ),
        )


def _severity_for_psi(psi_value: float) -> str:
    """Map a PSI value to the conventional severity band.

    * ``psi < PSI_WARN`` (0.1) → ``"no_shift"``
    * ``PSI_WARN <= psi < PSI_HIGH`` (0.2) → ``"warning"``
    * ``psi >= PSI_HIGH`` → ``"high"``
    """
    if psi_value < PSI_WARN:
        return "no_shift"
    if psi_value < PSI_HIGH:
        return "warning"
    return "high"


__all__ = [
    "DriftDetector",
    "MODEL_NAME",
    "OUTPUT_BASELINE_DAYS",
    "OUTPUT_CURRENT_HOURS",
    "EMBEDDING_BASELINE_DAYS",
    "EMBEDDING_CURRENT_HOURS",
    "EMBEDDING_SAMPLE_LIMIT",
    "PSI_WARN",
    "PSI_HIGH",
]
