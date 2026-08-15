"""Outcome / ROI Intelligence (Cat 11) — real implementations.

Three services, reading from the production-grade ``outcomes`` and
``outcome_department_rollups`` tables (declared in
``db_migrations/versions/020_intelligence_gap_tables.py``) and the
``usage_events`` cost substrate (Cat 8):

* :class:`OutcomeTracker` — attach a business outcome to a trace
  (``POST /orgs/{org_id}/intelligence/outcomes``). Persists to
  ``outcomes`` with a generated ``out_<uuid>`` id.
* :class:`OutcomeRollup` — per-department ROI rollup
  (``GET /orgs/{org_id}/intelligence/outcomes/departments``).
  Reads outcomes + cost-from-usage_events by department, computes
  ``net_roi = outcomes_value / cost`` (null if cost is 0), and
  persists a per-``(org_id, department, window)`` row to
  ``outcome_department_rollups``. Fires
  :func:`PromotionHook.on_drift_alert` for any department whose
  ROI is < 1× (i.e. cost > value) — the *Cat 11 analog* of the
  Cat 2/Cat 8 drift alert: a "low ROI department" is operational
  drift and the hook can be wired to fire a CFO/finance alert in
  a real deployment.
* :class:`DepartmentAnalytics` — top-level summary
  (``GET /orgs/{org_id}/intelligence/outcomes/analytics``). Picks
  the best/worst department, computes aggregate ROI, and surfaces
  the *anomaly list* (departments with ROI < 1× or where the
  outcome_count is zero despite high cost).

The package degrades gracefully when its dependencies are missing
or empty — the typical Eden pattern. An empty ``outcomes`` table
returns a ``"no outcome data"`` envelope; an empty
``usage_events`` table returns ``null`` cost_usd and ``null`` ROI.
The pattern is the same one
:mod:`eden.services.cost_intel` and
:mod:`eden.kb.episodic.memory_intel` use.

See ``docs/observability-gap/11-outcome-roi-intelligence.md``.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Public constants ─────────────────────────────────────────────────


#: ROI threshold below which a department is flagged as
#: "operational drift" (cost > value). The Cat 11 analog of the
#: Cat 2/Cat 8 z-score thresholds. Below 1× the LLM spend is
#: not generating proportional business value; the
#: :func:`PromotionHook.on_drift_alert` hook fires.
LOW_ROI_THRESHOLD: float = 1.0

#: Z-score threshold (computed only when ≥ 4 history points) above
#: which a department's ROI *change* is flagged as an anomaly.
#: ``None`` when the per-department series has < 4 points
#: (mirrors the Cat 13 ``QualityPredictor`` / Cat 8
#: ``CostAnomalyDetector`` minimum-window behaviour).
ROI_DRIFT_Z_THRESHOLD: float = 2.5

#: Outcome-type whitelist. The :class:`OutcomeTracker` accepts
#: any non-empty string but the analytics layer buckets outcomes
#: by ``type`` and downstream consumers (CFOs, the audit log)
#: benefit from a stable vocabulary. The list is intentionally
#: open — new types can be added without a code change; this
#: is the *recommended* set per the appendix.
KNOWN_OUTCOME_TYPES: frozenset[str] = frozenset(
    {
        "conversion",
        "lead",
        "revenue",
        "support_deflection",
        "feature_velocity",
        "cost_savings",
        "user_retention",
        "nps_lift",
        "ticket_resolved",
        "document_drafted",
    }
)


# ── Envelope helpers (mirror cost_intel / memory_intel) ──────────────


def _new_trace_id() -> str:
    """Cat 11-prefixed trace id — distinguishes live responses
    from Cat 1/2/8/16 in the audit log."""
    return f"out_{uuid.uuid4().hex[:12]}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """Live response envelope — same shape as the stub
    :class:`eden.intelligence_envelope.IntelligenceStubResponse`
    so the front-end renders uniformly. ``live=True`` signals a
    real implementation."""
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": data,
    }


def _bad_request_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for an invalid request (malformed body,
    unknown window). Returns ``status="bad_request"`` so the
    front-end renders a 4xx-class message without falling back
    to the stub envelope."""
    return {
        "status": "bad_request",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": {"message": message},
    }


def _safe_float(value: Any) -> float:
    """Coerce ``value`` to ``float``; return ``0.0`` for
    anything that isn't a number. Defensive belt-and-braces for
    the ROI / rollup arithmetic."""
    if isinstance(value, bool):
        # ``True``/``False`` would coerce to 1/0 — guard against
        # it; booleans are not outcomes.
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"``/``"Nd"``/``"Nm"``/``"Ns"``.
    Returns ``None`` on bad input (the service wraps that into a
    bad-request envelope). ``None`` or empty input defaults to
    ``"30 days"`` (the Cat 11 default per the API spec).

    Mirrors :func:`eden.services.cost_intel._common._parse_window`
    so the public surface across cats is consistent.
    """
    if window is None:
        return "30 days"
    s = window.strip()
    if not s:
        return "30 days"
    # Quick parse: integer + unit.
    if len(s) < 2:
        return None
    unit = s[-1].lower()
    head = s[:-1].strip()
    if not head.isdigit():
        return None
    if unit == "h":
        return f"{head} hours"
    if unit == "d":
        return f"{head} days"
    if unit == "m":
        return f"{head} minutes"
    if unit == "s":
        return f"{head} seconds"
    return None


# ── Data read paths ──────────────────────────────────────────────────


async def _get_client() -> Any:
    """Best-effort :func:`eden.storage.postgres.get_postgres_client`
    import + await. Returns ``None`` if Postgres isn't available —
    the fetchers and persistence helpers check for ``None`` and
    no-op or return ``[]``/``None``.

    Defensive: any import / await failure is logged at DEBUG
    and swallowed so the route always returns a valid envelope
    (the ``"no data"`` branch). The pattern is shared with
    :mod:`eden.services.cost_intel._common`.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("outcomes: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("outcomes: get_postgres_client failed: %s", exc)
        return None


async def _fetch_outcomes_by_department(
    org_id: str, interval_sql: str
) -> dict[str, dict[str, Any]]:
    """Aggregate ``outcomes`` by ``department`` for the given
    window. Returns
    ``{department: {outcome_count, value_usd}}`` — bucketed
    by ``type`` would be a secondary GROUP BY and isn't needed
    for the Cat 11 v0 surface. The rollup is the "killer query"
    for the CFO conversation.

    Empty/missing data → ``{}``. The service handles that as
    "no outcome data".
    """
    client = await _get_client()
    if client is None:
        return {}
    try:
        rows = await client.fetch(
            """
            SELECT COALESCE(department, '__missing__') AS department,
                   COUNT(*)::int                       AS outcome_count,
                   COALESCE(SUM(value), 0)::float8    AS value_usd
              FROM outcomes
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
             GROUP BY 1
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "outcomes: fetch_outcomes_by_department failed: %s", exc
        )
        return {}
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out[str(d.get("department"))] = {
            "outcome_count": int(d.get("outcome_count") or 0),
            "value_usd": _safe_float(d.get("value_usd")),
        }
    return out


async def _fetch_cost_by_department(
    org_id: str, interval_sql: str
) -> dict[str, float]:
    """Sum of ``cost_usd`` on ``usage_events`` bucketed by the
    ``department`` JSONB metadata field. Falls back to the
    literal string ``"__missing__"`` when the field is absent
    so the rollup is always well-formed.

    Empty/missing data → ``{}``. The rollup handles a
    department present in ``outcomes`` but absent here as
    ``cost_usd = 0.0`` (which yields ``net_roi = null`` via
    the ``cost = 0`` branch in the service).
    """
    client = await _get_client()
    if client is None:
        return {}
    try:
        rows = await client.fetch(
            """
            SELECT COALESCE(metadata->>'department', '__missing__') AS department,
                   COALESCE(SUM(cost_usd), 0)::float8              AS cost_usd
              FROM usage_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
               AND cost_usd IS NOT NULL
             GROUP BY 1
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "outcomes: fetch_cost_by_department failed: %s", exc
        )
        return {}
    return {
        str(d.get("department") if not isinstance(d, dict) else d["department"]): _safe_float(
            d.get("cost_usd") if not isinstance(d, dict) else d["cost_usd"]
        )
        for d in rows
    }


async def _fetch_rollup_history(
    org_id: str, department: str
) -> list[float]:
    """Last 90 days of ``roi`` values for one department from
    ``outcome_department_rollups``. Used for the per-department
    drift z-score. Returns ``[]`` on failure / empty.

    The 90-day window matches the appendix's predictive
    algorithm; < 4 points is the threshold for "insufficient
    history" so the analytics layer skips the z-score branch.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT roi
              FROM outcome_department_rollups
             WHERE org_id = $1
               AND department = $2
               AND created_at > NOW() - INTERVAL '90 days'
             ORDER BY created_at ASC
            """,
            org_id,
            department,
        )
    except Exception as exc:
        logger.debug(
            "outcomes: fetch_rollup_history failed: %s", exc
        )
        return []
    out: list[float] = []
    for r in rows:
        v = r.get("roi") if isinstance(r, dict) else r["roi"]
        if v is not None:
            out.append(_safe_float(v))
    return out


# ── Persistence ──────────────────────────────────────────────────────


async def _insert_outcome(
    org_id: str,
    trace_id: str,
    outcome_type: str,
    value: float,
    department: str | None,
) -> str | None:
    """Insert one row into ``outcomes``. Returns the generated
    ``out_<uuid>`` id on success, ``None`` on failure.

    The id is generated client-side so the response is
    deterministic and so the route can return the id even when
    the row write fails (the in-memory id is still useful for
    the audit log; the persistence is best-effort).
    """
    outcome_id = f"out_{uuid.uuid4().hex[:16]}"
    client = await _get_client()
    if client is None:
        return outcome_id
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO outcomes
                    (id, org_id, trace_id, type, value, department)
                VALUES ($1, $2, $3, $4, $5, $6)
                """,
                outcome_id, org_id, trace_id, outcome_type, value, department,
            )
    except Exception as exc:
        logger.debug(
            "outcomes: insert_outcome failed: %s", exc
        )
        return outcome_id  # best-effort — return the id anyway
    return outcome_id


async def _delete_then_insert_rollup(
    org_id: str,
    department: str,
    window: str,
    outcome_count: int,
    cost_usd: float | None,
    roi: float | None,
) -> None:
    """Replace the ``outcome_department_rollups`` row for
    ``(org_id, department, window)``. The migration has no
    unique constraint, so the clear-then-insert pattern is the
    only way to make the service re-runnable.

    Best-effort: any exception is logged and swallowed so the
    caller can still return the live envelope with the
    in-memory data.
    """
    client = await _get_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM outcome_department_rollups
                     WHERE org_id = $1
                       AND department = $2
                       AND window = $3
                    """,
                org_id, department, window,
            )
            await conn.execute(
                """
                    INSERT INTO outcome_department_rollups
                        (id, org_id, department, window,
                         outcome_count, cost_usd, roi)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
                    """,
                org_id, department, window, outcome_count,
                cost_usd, roi,
            )
    except Exception as exc:
        logger.debug(
            "outcomes: rollup write failed: %s", exc
        )


# ── Closed-loop hook firing ──────────────────────────────────────────


def _fire_low_roi_alert(
    org_id: str, departments: list[dict[str, Any]]
) -> None:
    """Fire :func:`PromotionHook.on_drift_alert` for each
    department whose ``net_roi`` is < :data:`LOW_ROI_THRESHOLD`
    (i.e. cost > value).

    Mirrors the Cat 2 / Cat 8 / Cat 13 pattern: high-severity
    drift fires the hook so the canary auto-rollback or
    CFO-notification channel can be wired in a real deployment.
    In stub mode the hook is a no-op logger.

    Drift type is ``"low_roi_department"`` so the front-end /
    audit log can grep for it. Severity is
    ``"high"`` when ``net_roi < 0.5`` (the spend is 2× the
    value), else ``"medium"`` — matches the cost_intel / rca
    severity band.

    Wrapped in try/except — the hook is best-effort and must
    never break the response.
    """
    low_roi = [
        d
        for d in departments
        if d.get("net_roi") is not None
        and d["net_roi"] < LOW_ROI_THRESHOLD
    ]
    if not low_roi:
        return
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception as exc:
        logger.debug("outcomes: hook import failed: %s", exc)
        return
    try:
        hook = get_promotion_hook()
    except Exception as exc:
        logger.debug("outcomes: get_promotion_hook failed: %s", exc)
        return
    for d in low_roi:
        severity = "high" if (d.get("net_roi") or 0.0) < 0.5 else "medium"
        try:
            # ``on_drift_alert`` is ``async def`` and this helper is sync —
            # a bare call dropped every low-ROI alert on the floor.
            from eden.async_tasks import fire_and_forget

            fire_and_forget(
                hook.on_drift_alert(
                    org_id,
                    drift_type="low_roi_department",
                    severity=severity,
                ),
                name="outcomes-low-roi-drift-hook",
            )
        except Exception as exc:
            logger.debug(
                "outcomes: on_drift_alert failed: %s", exc
            )


# ── Services ─────────────────────────────────────────────────────────


class OutcomeTracker:
    """Attach a business outcome to a single trace.

    Persists a single row to ``outcomes`` and returns a
    live envelope with the generated ``out_<uuid>`` id. This is
    the primary *write* path for Cat 11 — the rest of the
    surface (rollup, analytics) is read-only and joins against
    the rows this service writes.
    """

    name = "outcome_tracker"

    async def track(
        self,
        org_id: str,
        *,
        trace_id: str,
        outcome_type: str,
        value: float,
        department: str | None = None,
    ) -> dict[str, Any]:
        # Defensive input validation. The Pydantic body
        # already enforces the types, but a direct service
        # call (e.g. from a test) might pass ``None`` or an
        # empty string. ``trace_id`` and ``outcome_type`` are
        # non-nullable in the ``outcomes`` table; ``value``
        # can be 0 (free conversion) but not negative — the
        # appendix's failure-mode list calls out "value is
        # wrong" as a customer-input error, so we clamp.
        if not trace_id or not isinstance(trace_id, str):
            return _bad_request_envelope(
                self.name, "trace_id is required"
            )
        if not outcome_type or not isinstance(outcome_type, str):
            return _bad_request_envelope(
                self.name, "outcome_type is required"
            )
        # ``value`` can be 0.0 (a $0 outcome is legitimate)
        # but should not be negative; if a customer truly
        # needs a "refund" outcome the appendix's failure-mode
        # table recommends the dedicated ``outcome_voided``
        # flag, not a negative value.
        if not isinstance(value, (int, float)) or value < 0:
            return _bad_request_envelope(
                self.name,
                "value must be a non-negative number",
            )
        # Cap department at the column width (64). The
        # Pydantic body doesn't enforce length, so a careless
        # caller could send a 1k-char string and blow up the
        # INSERT.
        if department is not None:
            department = str(department)[:64]

        outcome_id = await _insert_outcome(
            org_id, trace_id, outcome_type, _safe_float(value), department
        )

        return _ok_envelope(
            self.name,
            {
                "outcome_id": outcome_id,
                "org_id": org_id,
                "trace_id": trace_id,
                "outcome_type": outcome_type,
                "value": _safe_float(value),
                "department": department,
                "known_outcome_type": outcome_type in KNOWN_OUTCOME_TYPES,
            },
        )


class OutcomeRollup:
    """Per-department ROI rollup — the *killer query* for the
    CFO conversation.

    Reads ``outcomes`` and ``usage_events`` (cost) bucketed by
    ``department``. Computes ``net_roi = outcomes_value / cost``
    (null when cost is 0). Persists a per-``(org_id, department,
    window)`` row to ``outcome_department_rollups``. Fires
    :func:`PromotionHook.on_drift_alert` for low-ROI
    departments (Cat 11's "drift" hook).
    """

    name = "outcome_rollup"

    async def by_department(
        self,
        org_id: str,
        *,
        window: str = "30d",
        department: str | None = None,
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '30d', '24h'",
            )
        # Defensive: cap department at the column width so
        # a careless caller can't blow up the SQL filter.
        if department is not None:
            department = str(department)[:64]

        outcomes_by_dept = await _fetch_outcomes_by_department(
            org_id, interval
        )
        cost_by_dept = await _fetch_cost_by_department(org_id, interval)

        # No data on either side → return the empty-envelope
        # shape so the front-end renders a clean "no outcome
        # data" message. Distinct from "no cost data" — both
        # yield the same envelope.
        if not outcomes_by_dept and not cost_by_dept:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "window": window,
                    "departments": [],
                    "totals": {
                        "outcome_count": 0,
                        "outcomes_value_usd": 0.0,
                        "cost_usd": 0.0,
                        "net_roi": None,
                    },
                    "message": "no outcome data",
                },
            )

        # Union of departments that have *either* outcomes or
        # cost. Sorting the union keeps the response stable
        # across calls so the front-end can render a sorted
        # table without re-sorting. The ``department``
        # query-param (the appendix's "killer query" filter)
        # narrows the union to a single department; an
        # unknown department yields an empty result with a
        # ``"no outcome data"`` envelope.
        all_departments = sorted(
            set(outcomes_by_dept) | set(cost_by_dept)
        )
        if department is not None:
            departments = [d for d in all_departments if d == department]
        else:
            departments = all_departments

        rows: list[dict[str, Any]] = []
        total_outcomes = 0
        total_value = 0.0
        total_cost = 0.0
        for dept in departments:
            outcomes = outcomes_by_dept.get(dept, {"outcome_count": 0, "value_usd": 0.0})
            cost = cost_by_dept.get(dept, 0.0)
            outcome_count = int(outcomes["outcome_count"])
            value = _safe_float(outcomes["value_usd"])
            if cost > 0:
                net_roi: float | None = value / cost
            else:
                net_roi = None
            # avg_value_per_outcome is the per-outcome mean;
            # useful for "how much is each conversion worth"
            # queries. None when the dept has no outcomes.
            if outcome_count > 0:
                avg_value: float | None = value / outcome_count
            else:
                avg_value = None
            alert: str | None = None
            if net_roi is not None and net_roi < LOW_ROI_THRESHOLD:
                alert = (
                    f"ROI < 1× for this window — cost (${cost:.0f}) "
                    f"exceeds outcome value (${value:.0f})"
                )
            rows.append(
                {
                    "department": dept,
                    "outcome_count": outcome_count,
                    "outcomes_value_usd": value,
                    "cost_usd": cost,
                    "net_roi": net_roi,
                    "avg_value_per_outcome": avg_value,
                    "alert": alert,
                }
            )
            total_outcomes += outcome_count
            total_value += value
            total_cost += cost

            # Persist the per-(org, dept, window) rollup. The
            # table has no unique constraint so the helper
            # does DELETE+INSERT to make the service
            # re-runnable.
            await _delete_then_insert_rollup(
                org_id,
                dept,
                window,
                outcome_count,
                cost if cost > 0 else None,
                net_roi,
            )

        # Sort departments by ROI descending (highest first);
        # the CFO wants to see the winners at the top.
        rows.sort(
            key=lambda r: (
                -(r["net_roi"] if r["net_roi"] is not None else float("-inf"))
            )
        )

        # Closed-loop: fire the drift alert for any low-ROI
        # department. Best-effort, never breaks the response.
        _fire_low_roi_alert(org_id, rows)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "window": window,
                "department_filter": department,
                "departments": rows,
                "totals": {
                    "outcome_count": total_outcomes,
                    "outcomes_value_usd": total_value,
                    "cost_usd": total_cost,
                    "net_roi": (total_value / total_cost) if total_cost > 0 else None,
                },
            },
        )


class DepartmentAnalytics:
    """Top-level summary of outcome / ROI metrics for the org.

    Picks the *best* and *worst* department (by ROI), computes
    the aggregate ROI, and surfaces the *anomaly list* —
    departments with ROI < 1× or where the outcome_count is
    zero despite high cost. The endpoint is the *executive
    summary* the CFO dashboard renders.

    Unlike :class:`OutcomeRollup`, this service does not
    persist to ``outcome_department_rollups`` — it reads the
    rollup table for the per-department ROI history to
    compute a per-department drift z-score. A department whose
    ROI has dropped > :data:`ROI_DRIFT_Z_THRESHOLD` σ vs its
    90-day baseline is surfaced as an "roi_regression" anomaly
    in the response.
    """

    name = "department_analytics"

    async def rollup(
        self,
        org_id: str,
        *,
        window: str = "30d",
        department: str | None = None,
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '30d', '24h'",
            )
        if department is not None:
            department = str(department)[:64]

        outcomes_by_dept = await _fetch_outcomes_by_department(
            org_id, interval
        )
        cost_by_dept = await _fetch_cost_by_department(org_id, interval)

        # No data → empty envelope. Same shape as the rollup
        # so the front-end can render the same "no data"
        # message.
        if not outcomes_by_dept and not cost_by_dept:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "window": window,
                    "summary": {
                        "total_outcome_count": 0,
                        "total_value_usd": 0.0,
                        "total_cost_usd": 0.0,
                        "net_roi": None,
                        "best_department": None,
                        "worst_department": None,
                    },
                    "anomalies": [],
                    "message": "no outcome data",
                },
            )

        # Build a unified per-department view. Same arithmetic
        # as :class:`OutcomeRollup` but inlined here so the
        # analytics layer can also compute drift z-scores
        # against the 90-day history. The ``department``
        # filter narrows the response to a single department
        # when the caller wants a focused drill-down.
        all_departments = sorted(
            set(outcomes_by_dept) | set(cost_by_dept)
        )
        if department is not None:
            departments = [d for d in all_departments if d == department]
        else:
            departments = all_departments
        per_dept: list[dict[str, Any]] = []
        for dept in departments:
            outcomes = outcomes_by_dept.get(dept, {"outcome_count": 0, "value_usd": 0.0})
            cost = cost_by_dept.get(dept, 0.0)
            outcome_count = int(outcomes["outcome_count"])
            value = _safe_float(outcomes["value_usd"])
            if cost > 0:
                net_roi: float | None = value / cost
            else:
                net_roi = None
            per_dept.append(
                {
                    "department": dept,
                    "outcome_count": outcome_count,
                    "value_usd": value,
                    "cost_usd": cost,
                    "net_roi": net_roi,
                }
            )

        # Aggregate metrics.
        total_outcomes = sum(d["outcome_count"] for d in per_dept)
        total_value = sum(d["value_usd"] for d in per_dept)
        total_cost = sum(d["cost_usd"] for d in per_dept)
        overall_roi: float | None = (
            (total_value / total_cost) if total_cost > 0 else None
        )

        # Best/worst department. ``None`` when no department
        # has a non-null ROI (every dept is missing cost).
        ranked = [d for d in per_dept if d["net_roi"] is not None]
        if ranked:
            best = max(ranked, key=lambda d: d["net_roi"] or float("-inf"))
            worst = min(ranked, key=lambda d: d["net_roi"] or float("inf"))
            best_summary = {
                "department": best["department"],
                "net_roi": best["net_roi"],
                "outcome_count": best["outcome_count"],
            }
            worst_summary = {
                "department": worst["department"],
                "net_roi": worst["net_roi"],
                "outcome_count": worst["outcome_count"],
            }
        else:
            best_summary = None
            worst_summary = None

        # Anomaly list:
        # (a) low_roi: net_roi < LOW_ROI_THRESHOLD
        # (b) roi_regression: z-score on the 90-day
        #     ``outcome_department_rollups.roi`` series is
        #     < -ROI_DRIFT_Z_THRESHOLD
        # (c) cost_without_outcomes: cost > 0 but
        #     outcome_count == 0 (data-quality / wiring issue)
        anomalies: list[dict[str, Any]] = []
        for d in per_dept:
            # (a) low_roi — uses *current window* ROI.
            if (
                d["net_roi"] is not None
                and d["net_roi"] < LOW_ROI_THRESHOLD
            ):
                anomalies.append(
                    {
                        "type": "low_roi",
                        "department": d["department"],
                        "severity": (
                            "high"
                            if d["net_roi"] < 0.5
                            else "medium"
                        ),
                        "net_roi": d["net_roi"],
                        "cost_usd": d["cost_usd"],
                        "value_usd": d["value_usd"],
                    }
                )
            # (c) cost without outcomes — pure data-quality
            # alert; not a drift event, but a "the wiring is
            # broken" signal.
            if d["cost_usd"] > 0 and d["outcome_count"] == 0:
                anomalies.append(
                    {
                        "type": "cost_without_outcomes",
                        "department": d["department"],
                        "severity": "info",
                        "cost_usd": d["cost_usd"],
                    }
                )

        # (b) ROI regression — for each department with ≥ 4
        # history points, compute a z-score of the current
        # window's net_roi vs the 90-day baseline. Negative
        # z-scores below the threshold are flagged.
        for d in per_dept:
            history = await _fetch_rollup_history(org_id, d["department"])
            if len(history) < 4:
                continue
            mean = sum(history) / len(history)
            sq = sum((v - mean) ** 2 for v in history)
            stdev = (sq / (len(history) - 1)) ** 0.5 if len(history) > 1 else 0.0
            if stdev == 0 or d["net_roi"] is None:
                continue
            z = (d["net_roi"] - mean) / stdev
            if z < -ROI_DRIFT_Z_THRESHOLD:
                anomalies.append(
                    {
                        "type": "roi_regression",
                        "department": d["department"],
                        "severity": (
                            "high" if z < -4.0 else "medium"
                        ),
                        "z_score": z,
                        "current_net_roi": d["net_roi"],
                        "baseline_mean": mean,
                        "baseline_stdev": stdev,
                        "history_points": len(history),
                    }
                )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "window": window,
                "department_filter": department,
                "summary": {
                    "total_outcome_count": total_outcomes,
                    "total_value_usd": total_value,
                    "total_cost_usd": total_cost,
                    "net_roi": overall_roi,
                    "best_department": best_summary,
                    "worst_department": worst_summary,
                },
                "anomalies": anomalies,
            },
        )
