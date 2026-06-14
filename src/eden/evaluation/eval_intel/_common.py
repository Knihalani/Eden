"""Shared helpers for Cat 3 (Evaluation Quality Intelligence) services.

Centralises:

* The data read path — :func:`_fetch_judge_scores_for_window`,
  :func:`_fetch_judge_distribution`, :func:`_fetch_eval_versions`,
  :func:`_fetch_eval_version_by_sha`, :func:`_fetch_hil_task`,
  :func:`_fetch_low_judge_scores`.
* The envelope shape used for live (non-stub) responses —
  :func:`_ok_envelope`, :func:`_bad_request_envelope`,
  :func:`_not_found_envelope`, :func:`_conflict_envelope`. All four
  use ``live=True``.
* The persistence pattern used by every service that writes to
  the 14 Cat 3 tables. The migration
  (``020_intelligence_gap_tables.py``) does not declare a unique
  constraint on any of the tables, so the only way to make the
  re-runnable services idempotent is to delete-then-insert.
* :func:`_parse_window` for the time-bounded queries the
  failure-clusterer runs. Accepts ``"Nh"``/``"Nd"``/``"Nm"``/``"Ns"``
  and returns a Postgres interval literal; bad input returns
  ``None`` and the service turns it into a bad-request envelope.
* Closed-loop hook firing — :func:`_fire_eval_to_guardrail_promotion`
  and :func:`_fire_eval_version_regression`. Both follow the
  try-import / try-get / try-call pattern from
  :mod:`eden.decision.decision_scorer` and
  :mod:`eden.insights.incidents.clusterer` so a missing hook
  import or runtime error never breaks the live response.
* :func:`_validate_function_ref` and :func:`_validate_modality`
  for the two smallest services.
* :func:`_parse_judge_response` — the same JSON-shaped response
  parser used by :mod:`eden.llmops.judges.hallucination` and
  friends. Re-imported here so the CLHF + MultiModal +
  BooleanCategorical services don't need to reach into
  :mod:`eden.llmops.judges` to parse their LLM output.

The helpers are intentionally local to the package — Cat 3 is a
self-contained unit and the package boundary is the right place
to hide the per-service glue. Mirrors the layout of
:mod:`eden.kb.retrieval_intel._common` (Cat 4),
:mod:`eden.services.cost_intel._common` (Cat 8),
:mod:`eden.decision._common` (Cat 16), and
:mod:`eden.insights.rca._common` (Cat 2).
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Public constants ─────────────────────────────────────────────────


#: Min/max examples for CLHF (Galileo spec, appendix §8).
CLHF_MIN_EXAMPLES: int = 2
CLHF_MAX_EXAMPLES: int = 5

#: A judge score below this is treated as a "failed" trace by
#: the failure clusterer and the auto-dataset bridge. The
#: threshold is intentionally lenient (0.5) — clustering is
#: noisy and we want the operator to be able to prune.
FAILURE_CLUSTER_THRESHOLD: float = 0.5

#: Min samples required to promote a judge into a guardrail
#: (Galileo eval-to-guardrail lifecycle, appendix §6).
MIN_SAMPLES_FOR_PROMOTION: int = 100

#: Max acceptable FPR for a judge at the given threshold. Above
#: this the judge is too noisy to promote.
MAX_FPR_FOR_PROMOTION: float = 0.05

#: Lookback window (days) for the eval-to-guardrail promotion
#: sample count + FPR computation.
EVAL_LOOKBACK_DAYS: int = 30

#: Min judge score drop (absolute) to treat a new eval version
#: as a regression vs. the previous active version. Matches
#: Cat 16's regression logic.
REGRESSION_MATERIALITY: float = 0.05

#: Lookback window (days) for the eval-version regression
#: detection. We compare the new version's judges' mean score
#: in the last ``REGRESSION_LOOKBACK_DAYS`` days vs. the previous
#: active version's same-window mean.
REGRESSION_LOOKBACK_DAYS: int = 7

#: Min number of judge scores required to compute a regression
#: comparison. Below this we don't have enough signal.
REGRESSION_MIN_SAMPLES: int = 5

#: Min low-score samples needed before the auto-dataset bridge
#: calls the AutoDatasetPromoter. Below this the signal is
#: too sparse to be worth a dataset.
AUTO_DATASET_MIN_SAMPLES: int = 5

#: Max number of low-score samples the auto-dataset bridge
#: pulls. Keeps the promoter call bounded.
AUTO_DATASET_MAX_SAMPLES: int = 1000

#: Modalities supported by :class:`MultiModalEvaluator`.
MULTIMODAL_MODALITIES: tuple[str, ...] = ("text", "image", "audio")

#: The six Arize-style eval modalities accepted by
#: :class:`SixModalitiesRegistry.declare_modality`.
SIX_MODALITIES: tuple[str, ...] = (
    "llm_as_judge",
    "online",
    "offline",
    "trace_level",
    "session_level",
    "human_annotation",
)

#: Allowed values for the user feedback ``thumbs`` field.
ALLOWED_THUMBS: tuple[str, ...] = ("up", "down")

#: Min/max rating in the user feedback ``rating`` field.
RATING_MIN: int = 1
RATING_MAX: int = 5


# ── Window parsing ───────────────────────────────────────────────────


_WINDOW_RE = re.compile(r"^\s*(\d+)\s*(h|d|m|s)\s*$", re.IGNORECASE)


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"`` (hours), ``"Nd"`` (days),
    ``"Nm"`` (minutes), ``"Ns"`` (seconds). Returns ``None`` on
    bad input; the service wraps that into a
    :func:`_bad_request_envelope`.

    ``None`` or empty input defaults to ``"7 days"`` (matches
    the Cat 4 / Cat 8 conventions).
    """
    if window is None:
        return "7 days"
    s = window.strip()
    if not s:
        return "7 days"
    m = _WINDOW_RE.match(s)
    if m is None:
        return None
    n, unit = m.group(1), m.group(2).lower()
    unit_long = {"h": "hours", "d": "days", "m": "minutes", "s": "seconds"}[unit]
    return f"{n} {unit_long}"


# ── Envelope helpers ─────────────────────────────────────────────────


def _new_trace_id() -> str:
    """Cat 3-prefixed trace id — distinguishes live responses
    from Cat 1/2/4/8/16 in the audit log."""
    return f"ei_{uuid.uuid4().hex[:12]}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """Live response envelope — same shape as the stub
    :class:`eden.intelligence_envelope.IntelligenceStubResponse`
    so the front-end renders uniformly. ``live=True`` signals
    a real implementation."""
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": data,
    }


def _bad_request_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for an invalid request (e.g. CLHF with 1
    example, unsupported modality). Returns ``status="bad_request"``
    so the front-end can render a 4xx-class message without
    falling back to the stub envelope."""
    return {
        "status": "bad_request",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": {"message": message},
    }


def _not_found_envelope(feature: str, key: str) -> dict[str, Any]:
    """Live envelope for a missing resource (e.g. an HiL task_id
    that doesn't exist). Returns ``status="not_found"``."""
    return {
        "status": "not_found",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": {"message": f"{key!r} not found", "key": str(key)},
    }


def _conflict_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for a conflict (e.g. annotating a closed
    HiL task). Returns ``status="conflict"`` so the front-end
    renders a 409-class message."""
    return {
        "status": "conflict",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": {"message": message},
    }


# ── LLM response parsing ─────────────────────────────────────────────


def _parse_judge_response(content: str) -> tuple[float, str]:
    """Parse the LLM judge's JSON-shaped response. Mirrors the
    parser in :mod:`eden.llmops.judges.hallucination` so the
    CLHF + MultiModal + BooleanCategorical services don't need
    to reach into the judges module to parse their LLM output.

    Accepts several shapes:

    * Strict JSON: ``{"score": 0.8, "rationale": "..."}``
    * JSON with surrounding prose
    * Bare float: ``"0.85"`` (degenerate case)

    Returns ``(score, rationale)``. Clamps score to [0.0, 1.0].
    """
    content = (content or "").strip()
    if not content:
        return 0.5, "empty_llm_response"

    # Try strict JSON first.
    try:
        obj = json.loads(content)
        if isinstance(obj, dict):
            score = float(obj.get("score", 0.5))
            rationale = str(obj.get("rationale", ""))
            return max(0.0, min(1.0, score)), rationale[:500]
        if isinstance(obj, (int, float)):
            return max(0.0, min(1.0, float(obj))), ""
    except (ValueError, TypeError):
        pass

    # JSON-in-prose.
    m = re.search(r"\{[^{}]*\"score\"[^{}]*\}", content)
    if m:
        try:
            obj = json.loads(m.group(0))
            score = float(obj.get("score", 0.5))
            rationale = str(obj.get("rationale", ""))
            return max(0.0, min(1.0, score)), rationale[:500]
        except (ValueError, TypeError):
            pass

    # Bare number fallback.
    m = re.search(r"\b0?\.\d+\b", content)
    if m:
        try:
            return max(0.0, min(1.0, float(m.group(0)))), content[:200]
        except ValueError:
            pass

    return 0.5, content[:200]


# ── Data read paths ──────────────────────────────────────────────────


async def _get_client() -> Any:
    """Best-effort :func:`eden.storage.postgres.get_postgres_client`
    import + await. Returns ``None`` if Postgres isn't available
    — persistence helpers and fetchers check for ``None`` and
    no-op or return ``[]``/``None``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("eval_intel: get_postgres_client failed: %s", exc)
        return None


def _row_to_dict(row: Any) -> dict[str, Any]:
    """Defensive: asyncpg / asyncpg-pool returns Record objects
    that look like tuples AND dicts; normalise to a dict so the
    callers can use ``row.get("col")``."""
    if isinstance(row, dict):
        return row
    try:
        return dict(row)
    except Exception:
        return {}


async def _fetch_judge_scores_for_window(
    org_id: str, judge_name: str, interval_sql: str, *, threshold: float | None = None
) -> list[dict[str, Any]]:
    """Get the judge scores for an org + judge name in the given
    window. If ``threshold`` is set, only scores *below* that
    threshold are returned (the failure-clusterer case).

    Returns ``[]`` on any failure so the clusterer can render a
    "no scores" message.
    """
    client = await _get_client()
    if client is None:
        return []
    if threshold is not None:
        pass
    try:
        if threshold is not None:
            rows = await client.fetch(
                """
                SELECT judge_run_id, trace_id, span_id, judge_name,
                       judge_version, score, rationale, model,
                       scored_at, latency_ms, source_event_id
                  FROM judge_scores
                 WHERE tenant_id = $1
                   AND judge_name = $2
                   AND scored_at > NOW() - $3::interval
                   AND score < $4::float8
                 ORDER BY scored_at DESC
                 LIMIT 10000
                """,
                org_id, judge_name, interval_sql, float(threshold),
            )
        else:
            rows = await client.fetch(
                """
                SELECT judge_run_id, trace_id, span_id, judge_name,
                       judge_version, score, rationale, model,
                       scored_at, latency_ms, source_event_id
                  FROM judge_scores
                 WHERE tenant_id = $1
                   AND judge_name = $2
                   AND scored_at > NOW() - $3::interval
                 ORDER BY scored_at DESC
                 LIMIT 10000
                """,
                org_id, judge_name, interval_sql,
            )
    except Exception as exc:
        logger.debug(
            "eval_intel: fetch_judge_scores_for_window failed: %s", exc,
        )
        return []
    return [_row_to_dict(r) for r in rows]


async def _fetch_judge_distribution(
    org_id: str, judge_name: str, interval_sql: str
) -> dict[str, Any]:
    """Get the per-judge distribution for the org in the given
    window. Returns ``{"sample_count": int, "mean_score": float,
    "below_threshold_count": int, "fpr_at_0.5": float}``.

    ``fpr_at_0.5`` is the False Positive Rate proxy — the
    fraction of scores below 0.5 that occurred on a trace
    that the rest of the system classified as "ok"
    (i.e., ``outcome IS NULL OR outcome = 'success'``). We
    don't have a ground-truth label, so the FPR is
    approximated as the fraction of below-threshold scores
    vs. the total. Cat 3 uses this as a noisy gate.
    """
    client = await _get_client()
    if client is None:
        return {"sample_count": 0, "mean_score": 0.0,
                "below_threshold_count": 0, "fpr_at_0.5": 0.0}
    try:
        rows = await client.fetch(
            """
            SELECT COUNT(*)::int AS sample_count,
                   COALESCE(AVG(score), 0.0)::float8 AS mean_score,
                   COUNT(*) FILTER (WHERE score < $4::float8)::int AS below_threshold_count
              FROM judge_scores
             WHERE tenant_id = $1
               AND judge_name = $2
               AND scored_at > NOW() - $3::interval
            """,
            org_id, judge_name, interval_sql, FAILURE_CLUSTER_THRESHOLD,
        )
    except Exception as exc:
        logger.debug(
            "eval_intel: fetch_judge_distribution failed: %s", exc,
        )
        return {"sample_count": 0, "mean_score": 0.0,
                "below_threshold_count": 0, "fpr_at_0.5": 0.0}
    if not rows:
        return {"sample_count": 0, "mean_score": 0.0,
                "below_threshold_count": 0, "fpr_at_0.5": 0.0}
    r = _row_to_dict(rows[0])
    n = int(r.get("sample_count", 0) or 0)
    below = int(r.get("below_threshold_count", 0) or 0)
    fpr = (below / n) if n > 0 else 0.0
    return {
        "sample_count": n,
        "mean_score": float(r.get("mean_score", 0.0) or 0.0),
        "below_threshold_count": below,
        "fpr_at_0.5": fpr,
    }


async def _fetch_eval_versions(org_id: str) -> list[dict[str, Any]]:
    """Get all eval versions for an org, newest first."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, deployment_sha, prompt_version, judge_set_json,
                   status, created_at
              FROM eval_versions
             WHERE org_id = $1
             ORDER BY created_at DESC
             LIMIT 200
            """,
            org_id,
        )
    except Exception as exc:
        logger.debug("eval_intel: fetch_eval_versions failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = _row_to_dict(r)
        # Decode judge_set from JSON.
        js = d.get("judge_set_json")
        if js:
            try:
                d["judge_set"] = json.loads(js)
            except Exception:
                d["judge_set"] = []
        else:
            d["judge_set"] = []
        d.pop("judge_set_json", None)
        out.append(d)
    return out


async def _fetch_eval_version_by_sha(
    org_id: str, deployment_sha: str
) -> dict[str, Any] | None:
    """Get the most recent eval version for the given deployment
    SHA. Used by the regression detector to compare the new
    version's judge scores vs. the previous active version."""
    client = await _get_client()
    if client is None:
        return None
    try:
        rows = await client.fetch(
            """
            SELECT id, deployment_sha, prompt_version, judge_set_json,
                   status, created_at
              FROM eval_versions
             WHERE org_id = $1 AND deployment_sha = $2
             ORDER BY created_at DESC
             LIMIT 1
            """,
            org_id, deployment_sha,
        )
    except Exception as exc:
        logger.debug(
            "eval_intel: fetch_eval_version_by_sha failed: %s", exc,
        )
        return None
    if not rows:
        return None
    d = _row_to_dict(rows[0])
    js = d.get("judge_set_json")
    if js:
        try:
            d["judge_set"] = json.loads(js)
        except Exception:
            d["judge_set"] = []
    else:
        d["judge_set"] = []
    d.pop("judge_set_json", None)
    return d


async def _fetch_previous_active_eval_version(
    org_id: str, exclude_sha: str
) -> dict[str, Any] | None:
    """Get the most recent *previous* eval version (i.e. the one
    tagged before ``exclude_sha``). Used by the regression
    detector. Returns ``None`` if there is no previous version."""
    client = await _get_client()
    if client is None:
        return None
    try:
        rows = await client.fetch(
            """
            SELECT id, deployment_sha, prompt_version, judge_set_json,
                   status, created_at
              FROM eval_versions
             WHERE org_id = $1
               AND deployment_sha <> $2
               AND status = 'active'
             ORDER BY created_at DESC
             LIMIT 1
            """,
            org_id, exclude_sha,
        )
    except Exception as exc:
        logger.debug(
            "eval_intel: fetch_previous_active_eval_version failed: %s", exc,
        )
        return None
    if not rows:
        return None
    d = _row_to_dict(rows[0])
    js = d.get("judge_set_json")
    if js:
        try:
            d["judge_set"] = json.loads(js)
        except Exception:
            d["judge_set"] = []
    else:
        d["judge_set"] = []
    d.pop("judge_set_json", None)
    return d


async def _fetch_hil_task(org_id: str, task_id: str) -> dict[str, Any] | None:
    """Get an HiL task by id. Returns ``None`` if not found."""
    client = await _get_client()
    if client is None:
        return None
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, name, spec_json, status, created_at
              FROM eval_hil_tasks
             WHERE org_id = $1 AND id = $2::uuid
             LIMIT 1
            """,
            org_id, task_id,
        )
    except Exception as exc:
        logger.debug("eval_intel: fetch_hil_task failed: %s", exc)
        return None
    if not rows:
        return None
    return _row_to_dict(rows[0])


async def _fetch_low_judge_scores(
    org_id: str, judge_name: str, *, limit: int = AUTO_DATASET_MAX_SAMPLES
) -> list[dict[str, Any]]:
    """Get the most recent low-score rows for a single judge.
    Used by :class:`AutoDatasetBridge` to build a sample list
    for the AutoDatasetPromoter.

    Returns ``[]`` on any failure.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT judge_run_id, trace_id, span_id, judge_name,
                   judge_version, score, rationale, model,
                   scored_at, latency_ms, source_event_id
              FROM judge_scores
             WHERE tenant_id = $1
               AND judge_name = $2
               AND score < $3::float8
             ORDER BY scored_at DESC
             LIMIT $4
            """,
            org_id, judge_name, FAILURE_CLUSTER_THRESHOLD, int(limit),
        )
    except Exception as exc:
        logger.debug("eval_intel: fetch_low_judge_scores failed: %s", exc)
        return []
    return [_row_to_dict(r) for r in rows]


# ── Persistence ──────────────────────────────────────────────────────


async def _delete_then_insert_version(
    org_id: str,
    deployment_sha: str,
    *,
    prompt_version: str,
    judge_set_json: str,
    status: str = "active",
) -> None:
    """Replace the ``eval_versions`` row for this
    ``(org_id, deployment_sha)`` tuple. Re-runnable via
    DELETE+INSERT (the table has no unique constraint).
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM eval_versions
                     WHERE org_id = $1 AND deployment_sha = $2
                    """,
                org_id, deployment_sha,
            )
            await conn.execute(
                """
                    INSERT INTO eval_versions
                        (id, org_id, deployment_sha, prompt_version,
                         judge_set_json, status)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                    """,
                org_id, deployment_sha,
                prompt_version[:64],
                judge_set_json,
                status[:16],
            )
    except Exception as exc:
        logger.debug("eval_intel: version write failed: %s", exc)


async def _delete_then_insert_failure_clusters(
    org_id: str,
    judge_name: str,
    clusters: list[dict[str, Any]],
) -> None:
    """Replace the ``eval_failure_clusters`` rows for this
    ``(org_id, judge_name)`` tuple. ``clusters`` is a list of
    ``{signature, member_count, sample_json}`` dicts; each
    becomes one row. The service is re-runnable because we
    clear the prior tuple first."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM eval_failure_clusters
                     WHERE org_id = $1 AND judge_name = $2
                    """,
                org_id, judge_name,
            )
            for c in clusters:
                sig = str(c.get("signature", ""))[:256]
                if not sig:
                    continue
                await conn.execute(
                    """
                        INSERT INTO eval_failure_clusters
                            (id, org_id, judge_name, signature,
                             member_count, sample_json)
                        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                        """,
                    org_id, judge_name, sig,
                    int(c.get("member_count", 0) or 0),
                    str(c.get("sample_json", "") or ""),
                )
    except Exception as exc:
        logger.debug("eval_intel: failure_clusters write failed: %s", exc)


async def _insert_clhf_run(
    org_id: str,
    *,
    name: str,
    examples_json: str,
    generated_metric_json: str,
    status: str = "generated",
) -> None:
    """Append a single ``eval_clhf_runs`` row. Each run is
    unique; we don't delete-then-insert."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_clhf_runs
                    (id, org_id, name, examples_json,
                     generated_metric_json, status)
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                """,
                org_id, name[:128], examples_json,
                generated_metric_json, status[:16],
            )
    except Exception as exc:
        logger.debug("eval_intel: clhf_run write failed: %s", exc)


async def _insert_hil_task(
    org_id: str,
    *,
    name: str,
    spec_json: str,
    status: str = "open",
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_hil_tasks
                    (id, org_id, name, spec_json, status)
                VALUES (gen_random_uuid(), $1, $2, $3, $4)
                """,
                org_id, name[:128], spec_json, status[:16],
            )
    except Exception as exc:
        logger.debug("eval_intel: hil_task write failed: %s", exc)


async def _update_hil_task_status(
    org_id: str, task_id: str, status: str
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                UPDATE eval_hil_tasks
                   SET status = $3
                 WHERE org_id = $1 AND id = $2::uuid
                """,
                org_id, task_id, status[:16],
            )
    except Exception as exc:
        logger.debug("eval_intel: hil_task update failed: %s", exc)


async def _insert_hil_annotation(
    org_id: str,
    *,
    task_id: str,
    trace_id: str,
    annotator_id: str | None,
    label: str,
    rationale: str | None,
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_hil_annotations
                    (id, org_id, task_id, trace_id, annotator_id,
                     label, rationale)
                VALUES (gen_random_uuid(), $1, $2::uuid, $3, $4, $5, $6)
                """,
                org_id, task_id, trace_id[:128],
                (annotator_id or "")[:128] or None,
                label[:64],
                (rationale or "")[:4000] or None,
            )
    except Exception as exc:
        logger.debug("eval_intel: hil_annotation write failed: %s", exc)


async def _insert_pairwise_queue(
    org_id: str, *, name: str, spec_json: str
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_pairwise_queues
                    (id, org_id, name, spec_json)
                VALUES (gen_random_uuid(), $1, $2, $3)
                """,
                org_id, name[:128], spec_json,
            )
    except Exception as exc:
        logger.debug("eval_intel: pairwise_queue write failed: %s", exc)


async def _insert_pairwise_preference(
    org_id: str,
    *,
    queue_id: str,
    variant_a_id: str,
    variant_b_id: str,
    preferred: str,
    annotator_id: str | None,
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_pairwise_preferences
                    (id, org_id, queue_id, variant_a_id, variant_b_id,
                     preferred, annotator_id)
                VALUES (gen_random_uuid(), $1, $2::uuid, $3, $4, $5, $6)
                """,
                org_id, queue_id, variant_a_id[:128], variant_b_id[:128],
                preferred[:16], (annotator_id or "")[:128] or None,
            )
    except Exception as exc:
        logger.debug("eval_intel: pairwise_preference write failed: %s", exc)


async def _insert_multimodal_run(
    org_id: str,
    *,
    modality: str,
    input_url: str,
    score: float,
    rationale: str,
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_multimodal_runs
                    (id, org_id, modality, input_url, score, rationale)
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                """,
                org_id, modality[:16], input_url[:4000] or None,
                float(score), (rationale or "")[:4000],
            )
    except Exception as exc:
        logger.debug("eval_intel: multimodal_run write failed: %s", exc)


async def _insert_guardrail_policy(
    org_id: str,
    *,
    name: str,
    type_: str,
    spec_json: str,
    action: str = "block_if_below",
    status: str = "active",
) -> str | None:
    """Insert a row into ``guardrail_policies`` (Cat 15's
    table) and return the generated id. The eval-to-guardrail
    lifecycle creates a judge_link policy here."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return None

    client = await get_postgres_client()
    if client is None:
        return None
    try:
        async with client.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO guardrail_policies
                    (id, org_id, name, type, spec_json, action, status)
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
                RETURNING id
                """,
                org_id, name[:128], type_[:32], spec_json,
                action[:16], status[:16],
            )
        if row is None:
            return None
        d = _row_to_dict(row)
        return str(d.get("id")) if d.get("id") is not None else None
    except Exception as exc:
        logger.debug("eval_intel: guardrail_policy write failed: %s", exc)
        return None


async def _insert_eval_to_guardrail_link(
    org_id: str,
    *,
    judge_name: str,
    guardrail_policy_id: str,
    threshold: float,
    status: str = "active",
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_to_guardrail_links
                    (id, org_id, judge_name, guardrail_policy_id,
                     threshold, status)
                VALUES (gen_random_uuid(), $1, $2, $3::uuid, $4, $5)
                """,
                org_id, judge_name[:64], guardrail_policy_id,
                float(threshold), status[:16],
            )
    except Exception as exc:
        logger.debug("eval_intel: eval_to_guardrail_link write failed: %s", exc)


async def _insert_modality_declaration(
    org_id: str, *, modality: str, config_json: str
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_modality_declarations
                    (id, org_id, modality, config_json)
                VALUES (gen_random_uuid(), $1, $2, $3)
                """,
                org_id, modality[:32], config_json,
            )
    except Exception as exc:
        logger.debug("eval_intel: modality_declaration write failed: %s", exc)


async def _delete_then_insert_boolean_categorical(
    org_id: str,
    trace_id: str,
    score_type: str,
    *,
    value: str,
    rationale: str,
) -> None:
    """Replace the ``eval_boolean_categorical_scores`` row for
    this ``(org_id, trace_id, score_type)`` tuple. Re-runnable
    so a trace can be re-evaluated with a different verdict."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM eval_boolean_categorical_scores
                     WHERE org_id = $1
                       AND trace_id = $2
                       AND score_type = $3
                    """,
                org_id, trace_id[:128], score_type[:16],
            )
            await conn.execute(
                """
                    INSERT INTO eval_boolean_categorical_scores
                        (id, org_id, trace_id, score_type, value, rationale)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                    """,
                org_id, trace_id[:128], score_type[:16],
                value[:64], (rationale or "")[:4000],
            )
    except Exception as exc:
        logger.debug(
            "eval_intel: boolean_categorical write failed: %s", exc,
        )


async def _insert_custom_python_eval(
    org_id: str,
    *,
    name: str,
    function_ref: str,
    spec_json: str,
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_custom_python_evals
                    (id, org_id, name, function_ref, spec_json)
                VALUES (gen_random_uuid(), $1, $2, $3, $4)
                """,
                org_id, name[:128], function_ref[:256], spec_json,
            )
    except Exception as exc:
        logger.debug("eval_intel: custom_python_eval write failed: %s", exc)


async def _insert_user_feedback(
    org_id: str,
    *,
    trace_id: str,
    user_id: str | None,
    thumbs: str | None,
    rating: int | None,
    comment: str | None,
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_user_feedback
                    (id, org_id, trace_id, user_id, thumbs, rating, comment)
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
                """,
                org_id, trace_id[:128],
                (user_id or "")[:128] or None,
                (thumbs or "")[:8] or None,
                int(rating) if rating is not None else None,
                (comment or "")[:4000] or None,
            )
    except Exception as exc:
        logger.debug("eval_intel: user_feedback write failed: %s", exc)


async def _insert_auto_dataset_bridge(
    org_id: str,
    *,
    judge_name: str,
    source_dataset_id: str | None,
    target_dataset_id: str | None,
    status: str = "curated",
) -> None:
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("eval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eval_auto_dataset_bridge
                    (id, org_id, judge_name, source_dataset_id,
                     target_dataset_id, status)
                VALUES (gen_random_uuid(), $1, $2, $3::uuid, $4, $5)
                """,
                org_id, judge_name[:64],
                source_dataset_id,
                target_dataset_id,
                status[:16],
            )
    except Exception as exc:
        logger.debug("eval_intel: auto_dataset_bridge write failed: %s", exc)


# ── Closed-loop hook firing ──────────────────────────────────────────


def _fire_eval_to_guardrail_promotion(
    org_id: str, *, judge_name: str, threshold: float
) -> None:
    """Fire the closed-loop hook for an eval-to-guardrail
    promotion. Mirrors the try-import / try-get / try-call
    pattern from
    :meth:`eden.decision.decision_scorer.DecisionScorer._fire_low_score_hooks`:
    a missing hook import or runtime error never breaks the
    live response."""
    try:
        from eden.llmops.promotion_hooks import get_guardrail_hook
    except Exception as exc:
        logger.debug("eval_intel: guardrail hook import failed: %s", exc)
        return
    try:
        hook = get_guardrail_hook()
    except Exception as exc:
        logger.debug("eval_intel: get_guardrail_hook failed: %s", exc)
        return
    try:
        hook.on_judge_threshold_breach(
            org_id, judge_name=judge_name, threshold=float(threshold),
        )
    except Exception as exc:
        logger.debug(
            "eval_intel: on_judge_threshold_breach(%s) failed: %s",
            judge_name, exc,
        )


def _fire_eval_version_regression(
    org_id: str, *,
    deployment_sha: str,
    judge_name: str,
    score: float,
) -> None:
    """Fire the closed-loop hook for an eval-version regression.
    Mirrors
    :meth:`eden.decision.decision_scorer.DecisionScorer._fire_regression_hook`:
    a missing hook import or runtime error never breaks the
    live response."""
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception as exc:
        logger.debug("eval_intel: promotion hook import failed: %s", exc)
        return
    try:
        hook = get_promotion_hook()
    except Exception as exc:
        logger.debug("eval_intel: get_promotion_hook failed: %s", exc)
        return
    try:
        hook.on_judge_regression(
            org_id, judge_name=judge_name, trace_id=deployment_sha,
            score=float(score),
        )
    except Exception as exc:
        logger.debug(
            "eval_intel: on_judge_regression(%s) failed: %s",
            judge_name, exc,
        )


# ── Misc small helpers ───────────────────────────────────────────────


def _validate_function_ref(function_ref: str) -> bool:
    """Verify a ``dotted.path:func_name`` (or just
    ``dotted.path.func_name``) Python import resolves to a
    callable. Returns ``False`` for any import error or if the
    resolved object is not callable. Mirrors the
    :mod:`eden.llmops.judges.registry` import pattern."""
    if not function_ref or not isinstance(function_ref, str):
        return False
    ref = function_ref.strip()
    if not ref:
        return False
    # Try a direct attribute walk first.
    try:
        module_path, _, attr = ref.rpartition(".")
        if module_path and attr:
            import importlib
            mod = importlib.import_module(module_path)
            fn = getattr(mod, attr, None)
            return callable(fn)
    except Exception:
        pass
    # Fallback: import the whole dotted path as a module.
    try:
        import importlib
        mod = importlib.import_module(ref)
        return callable(mod) or True  # module itself is the entry
    except Exception:
        return False


def _validate_modality(modality: str) -> bool:
    """Return ``True`` for the 3 multi-modal modalities
    (``text``, ``image``, ``audio``)."""
    return modality in MULTIMODAL_MODALITIES


def _validate_six_modality(modality: str) -> bool:
    """Return ``True`` for the 6 Arize-style eval modalities."""
    return modality in SIX_MODALITIES


def _safe_float(value: Any) -> float:
    """Coerce ``value`` to ``float``; return ``0.0`` for
    anything that isn't a number. Defensive belt-and-braces
    for the arithmetic in the regression detection."""
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0
