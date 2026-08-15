"""Shared helpers for Cat 9 (User Intelligence) services.

Centralises:

* Envelope shape — :func:`_ok_envelope`,
  :func:`_bad_request_envelope`. Both use ``live=True`` so
  the front-end renders the same way it does for the other
  shipped cats.
* The Postgres client helper — :func:`_get_client`. Mirrors
  the pattern in :mod:`eden.services.cost_intel._common` and
  :mod:`eden.analytics.outcomes.tracker`.
* The window parser — :func:`_parse_window`. Accepts
  ``"Nh"``/``"Nd"``/``"Nm"``/``"Ns"``; returns a Postgres
  interval literal. ``None`` on bad input.
* :func:`_new_id` — generates prefixed ids
  (``sess_…``, ``sig_…``, ``conv_…``, ``msg_…``, ``fb_…``,
  ``goal_…``, ``seg_…``, ``sat_…``) for the various write
  paths.
* :func:`_safe_float` — defensive coercion for the
  arithmetic in the satisfaction / behavioural services.
* :func:`_fire_low_satisfaction_alert` — closed-loop hook
  firing for low coverage-weighted satisfaction
  (Cat 17 :func:`PromotionHook.on_drift_alert`).
* :func:`_parse_thumbs` — normalise thumbs-up/down strings
  (accepts ``"up"``/``"down"``/``"thumbs_up"``/``"thumbs_down"``/
  ``"positive"``/``"negative"``/``"+1"``/``"-1"``).

Why a separate ``_common`` module
---------------------------------

The Cat 9 surface is split across 5 service files
(``sessions``, ``conversations``, ``feedback``, ``segments``,
``satisfaction``, ``behavioural``) plus the existing
``analytics`` stub. Centralising the envelope + Postgres
helper + window parser + hook firing means each service is
~150-200 lines of focused logic, not 400+ lines of glue.

Mirrors the layout of :mod:`eden.services.cost_intel._common`
and :mod:`eden.decision._common` (Cat 16).
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Public constants ─────────────────────────────────────────────────


#: Default coverage weights for the
#: :func:`coverage_weighted_satisfaction` aggregator. The 0.03 /
#: 0.97 split comes from the 2026 user-feedback research —
#: explicit feedback covers 1-3% of interactions, so the
#: implicit signal carries 97% of the weight. Per the
#: appendix: "the behavioural signal is 7-10× more honest
#: than the explicit signal." The default is the *prior*; a
#: tenant can override in ``organizations.features``.
DEFAULT_EXPLICIT_WEIGHT: float = 0.03
DEFAULT_IMPLICIT_WEIGHT: float = 0.97

#: Threshold below which a coverage-weighted satisfaction
#: signal is considered operational drift (Cat 17 hook fires).
LOW_SATISFACTION_THRESHOLD: float = 0.4

#: Window for the Bayesian Hierarchical Beta-Binomial prior
#: (how many days of explicit feedback to use to estimate
#: the per-channel rate). Per arXiv 2605.12177, the prior
#: must be at least 30 days of feedback to be meaningful;
#: smaller windows fall back to a non-informative
#: ``Beta(1, 1)`` prior.
BAYESIAN_PRIOR_WINDOW_DAYS: int = 30

#: Pseudocount for the Beta prior. A ``Beta(alpha0, beta0)``
#: prior with ``alpha0 = beta0 = 1`` is the uniform
#: (non-informative) prior — used when the per-channel
#: prior is below the
#: :data:`BAYESIAN_PRIOR_WINDOW_DAYS` window.
BETA_PSEUDOCOUNT: float = 1.0

#: 95% credible interval quantiles. The correction
#: :func:`SelectionBiasCorrector.correct` returns the
#: ``[0.025, 0.975]`` quantiles of the posterior.
CREDIBLE_INTERVAL_LOW: float = 0.025
CREDIBLE_INTERVAL_HIGH: float = 0.975

#: Window for the *return-7d* signal — a user is considered
#: "returned" if they re-engage within this many days of
#: the original trace. The signal is ``null`` until 7 days
#: have passed since the trace.
RETURN_7D_WINDOW_DAYS: int = 7


# ── Window parsing ───────────────────────────────────────────────────


_WINDOW_RE = re.compile(r"^\s*(\d+)\s*(h|d|m|s)\s*$", re.IGNORECASE)


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"``/``"Nd"``/``"Nm"``/``"Ns"``.
    Returns ``None`` on bad input; the service wraps that
    into a ``_bad_request_envelope``.

    ``None`` or empty input defaults to ``"7 days"`` (matches
    the Cat 9 default per the API spec).
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
    unit_long = {"h": "hours", "d": "days", "m": "minutes", "s": "seconds"}[
        unit
    ]
    return f"{n} {unit_long}"


# ── Envelope helpers ─────────────────────────────────────────────────


def _new_id(prefix: str) -> str:
    """Generate a prefixed id. The prefix is one of
    ``sess_``, ``sig_``, ``conv_``, ``msg_``, ``fb_``, ``goal_``,
    ``seg_``, ``sat_``, ``bs_``."""
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


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
        "trace_id": _new_id("ui"),
        "timestamp": _now_iso(),
        "data": data,
    }


def _bad_request_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for an invalid request (malformed body,
    unknown window, bad thumbs). Returns ``status="bad_request"``
    so the front-end renders a 4xx-class message without
    falling back to the stub envelope."""
    return {
        "status": "bad_request",
        "feature": feature,
        "live": True,
        "trace_id": _new_id("ui"),
        "timestamp": _now_iso(),
        "data": {"message": message},
    }


# ── Data read paths ──────────────────────────────────────────────────


async def _get_client() -> Any:
    """Best-effort :func:`eden.storage.postgres.get_postgres_client`
    import + await. Returns ``None`` if Postgres isn't available —
    the fetchers and persistence helpers check for ``None`` and
    no-op or return ``[]``/``None``.

    Defensive: any import / await failure is logged at DEBUG
    and swallowed so the route always returns a valid envelope
    (the ``"no data"`` branch).
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("user_intel: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("user_intel: get_postgres_client failed: %s", exc)
        return None


# ── Misc small helpers ───────────────────────────────────────────────


def _safe_float(value: Any) -> float:
    """Coerce ``value`` to ``float``; return ``0.0`` for
    anything that isn't a number. Defensive belt-and-braces
    for the arithmetic in the satisfaction / behavioural
    services."""
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


# Canonical thumbs tokens. Both the short (``"up"``) and the
# long (``"thumbs_up"``) forms are accepted. ``"+"`` / ``"-"``
# are accepted for SDK brevity. Anything else is rejected at
# the route layer.
_THUMBS_NORMALISE: dict[str, str] = {
    "up": "up",
    "thumbs_up": "up",
    "thumbsup": "up",
    "positive": "up",
    "+1": "up",
    "+": "up",
    "1": "up",
    "true": "up",
    "down": "down",
    "thumbs_down": "down",
    "thumbsdown": "down",
    "negative": "down",
    "-1": "down",
    "-": "down",
    "0": "down",
    "false": "down",
}


def _parse_thumbs(thumbs: Any) -> str | None:
    """Normalise a thumbs-up/down string. Returns ``"up"`` /
    ``"down"`` for valid input, ``None`` for anything else.

    The Cat 9 spec accepts ``"up"``/``"down"``/``"thumbs_up"``/
    ``"thumbs_down"``/``"positive"``/``"negative"``/``"+1"``/
    ````"-1"`` — the SDK is a mix of conventions (Langfuse
    uses ``"positive"``/``"negative"``, LangSmith uses
    ``1``/``0``). Anything else is a bad request.
    """
    if not isinstance(thumbs, str):
        return None
    s = thumbs.strip().lower().replace(" ", "_")
    return _THUMBS_NORMALISE.get(s)


# ── Closed-loop hook firing ──────────────────────────────────────────


def _fire_low_satisfaction_alert(
    org_id: str,
    trace_id: str,
    coverage_weighted: float,
) -> None:
    """Fire :func:`PromotionHook.on_drift_alert` when the
    coverage-weighted satisfaction is below
    :data:`LOW_SATISFACTION_THRESHOLD`.

    Mirrors the Cat 2 / Cat 8 / Cat 11 hook-firing pattern.
    Drift type is ``"low_user_satisfaction"`` so the
    front-end / audit log can grep for it.

    Wrapped in try/except — the hook is best-effort and
    must never break the response.
    """
    if coverage_weighted >= LOW_SATISFACTION_THRESHOLD:
        return
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception as exc:
        logger.debug("user_intel: hook import failed: %s", exc)
        return
    try:
        hook = get_promotion_hook()
    except Exception as exc:
        logger.debug("user_intel: get_promotion_hook failed: %s", exc)
        return
    severity = "high" if coverage_weighted < 0.2 else "medium"
    try:
        # ``on_drift_alert`` is ``async def`` and this helper is sync —
        # a bare call dropped every low-satisfaction alert on the floor.
        from eden.async_tasks import fire_and_forget

        fire_and_forget(
            hook.on_drift_alert(
                org_id,
                drift_type="low_user_satisfaction",
                severity=severity,
            ),
            name="user-intel-low-satisfaction-hook",
        )
    except Exception as exc:
        logger.debug("user_intel: on_drift_alert failed: %s", exc)
