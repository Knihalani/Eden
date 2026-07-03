"""Behavioural-signal services (Cat 9 v2 — the 4 implicit signals).

ponytail: per upgradespec §D.2 (Phase 1 cut), the 7
signals were reduced to 4. The 3 dropped
(copy_pasted / retried_within_60s / return_7d) were
re-runnable from derived metrics and aren't worth the
storage + write-path cost for beta.

Three write-path trackers + the :class:`BehaviouralDashboard`
read-path service. All write to
``user_behavioural_signals`` (migration 024). All read
the same table to compute cohort-level aggregates.

The 4 surviving signals per ``(org_id, trace_id)``:

1. **regenerated** — the user clicked "regenerate" on
   this trace. Negative signal.
2. **abandoned_after_one** — the user did not engage
   with the response (no copy, no click, no follow-up).
   Negative signal.
3. **edit_distance** — Levenshtein distance between the
   model's response and what the user eventually pasted
   / used, normalized to ``[0.0, 1.0]``. Negative signal
   when ``> 0.5``.
4. **time_to_first_action_ms** — how long the user took
   to take their first action. Diagnostic, not used in
   the implicit aggregate.

The :class:`BehaviouralDashboard.cohort` aggregate
mirrors the appendix's ``GET /intelligence/user/dashboard/cohort``
endpoint — the org-level view of the 4 signals across a
cohort of users.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    _bad_request_envelope,
    _get_client,
    _new_id,
    _ok_envelope,
    _parse_window,
)

logger = logging.getLogger(__name__)


#: PII-stripping length. The :class:`CopyPasteTracker` PII
#: pre-mask is performed by the AI Gateway's
#: :class:`PIIFilter` (the existing infrastructure) — the
#: Cat 9 service receives a *redacted* snippet of length
#: ≤ :data:`COPY_PASTE_REDACT_LEN` chars.
COPY_PASTE_REDACT_LEN: int = 200

#: The default time threshold (in seconds) for
#: "retried_within_60s". A user retrying with the same /
#: similar query within 60s is a strong negative signal
#: (the response wasn't good enough the first time).
RETRY_THRESHOLD_S: int = 60

#: The default edit-distance window (in seconds). The
#: :class:`EditDistanceTracker` accepts the model
#: response and the user's final text (the SDK passes
#: both) and computes the Levenshtein distance
#: normalised to ``[0.0, 1.0]``. A large window is a
#: sign the user is using the model as a *starting
#: point* and editing later.
EDIT_DISTANCE_WINDOW_S: int = 86_400  # 24h

#: The regeneration-rate threshold above which the
#: :class:`BehaviouralDashboard` fires an alert. Per the
#: Cat 9 spec: a 60%+ regen rate on technical queries is
#: diagnostic — segmentation beats vanity metrics.
DEFAULT_REGEN_ALERT_THRESHOLD: float = 0.5


# ── Shared helpers ───────────────────────────────────────────────────


async def _upsert_signal_row(
    org_id: str,
    user_id: str,
    trace_id: str,
    fields: dict[str, Any],
) -> str:
    """Upsert one row into ``user_behavioural_signals`` for
    ``(org_id, trace_id)``. The schema doesn't have a
    unique constraint, so the upsert is implemented as
    DELETE-then-INSERT (the same pattern used by the Cat 8
    and Cat 11 services for the migration's no-unique-
    constraint tables).

    Returns the generated ``sig_…`` id.
    """
    sig_id = _new_id("sig")
    client = await _get_client()
    if client is None:
        return sig_id
    try:
        # Map known field names to their column names
        # in the schema.
        col_map: dict[str, str] = {
            "regenerated": "regenerated",
            "abandoned_after_one": "abandoned_after_one",
            "edit_distance": "edit_distance",
            "time_to_first_action_ms": "time_to_first_action_ms",
            # ponytail: copy_pasted / retried_within_60s /
            # return_7d removed per upgradespec §D.2.
        }
        # DELETE first (re-runnable).
        await client.execute(
            """
            DELETE FROM user_behavioural_signals
             WHERE org_id = $1 AND trace_id = $2
            """,
            org_id,
            trace_id,
        )
        # Build the INSERT dynamically.
        cols = ["id", "org_id", "user_id", "trace_id"]
        vals: list[Any] = [sig_id, org_id, user_id, trace_id]
        placeholders = ["$1", "$2", "$3", "$4"]
        idx = 5
        for k, v in fields.items():
            col = col_map.get(k, k)
            cols.append(col)
            # Booleans need a bool cast; numerics stay
            # as floats; None passes through.
            if isinstance(v, bool):
                vals.append(v)
            elif v is None:
                vals.append(None)
            elif isinstance(v, (int, float)):
                vals.append(float(v))
            else:
                vals.append(v)
            placeholders.append(f"${idx}")
            idx += 1
        cols.append("created_at")
        placeholders.append("NOW()")
        sql = (
            f"INSERT INTO user_behavioural_signals "
            f"({', '.join(cols)}) "
            f"VALUES ({', '.join(placeholders)})"
        )
        await client.execute(sql, *vals)
    except Exception as exc:
        logger.debug("user_intel: signal upsert failed: %s", exc)
    return sig_id


async def _fetch_signal_cohort(
    org_id: str, interval: Any,
) -> dict[str, Any]:
    """Aggregate the ``user_behavioural_signals`` rows for
    ``org_id`` in the window ``interval`` (a Postgres interval
    literal string like ``"30 days"`` from
    :func:`eden.services.user_intel._common._parse_window`).

    Returns a dict with the per-cohort sums the dashboard
    needs:

        {
            "total": int,
            "regen_count": int,
            "abandon_count": int,
            "returned_yes": int,
            "returned_no": int,
            "edit_distance_mean": float | None,
            "ttfa_mean": float | None,
        }

    Best-effort: returns ``{}`` on DB error / no rows so the
    caller's ``if not signal_agg and not explicit_agg`` branch
    fires correctly.
    """
    client = await _get_client()
    if client is None:
        return {}
    try:
        row = await client.fetchrow(
            """
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE regenerated)::int AS regen_count,
                COUNT(*) FILTER (WHERE abandoned_after_one)
                    ::int AS abandon_count,
                COUNT(*) FILTER (WHERE returned)::int AS returned_yes,
                COUNT(*) FILTER (WHERE NOT returned)::int AS returned_no,
                AVG(edit_distance)::float AS edit_distance_mean,
                AVG(time_to_first_action_ms)::float AS ttfa_mean
              FROM user_behavioural_signals
             WHERE org_id = $1
               AND created_at >= NOW() - $2::interval
            """,
            org_id, str(interval),
        )
    except Exception as exc:
        logger.debug("user_intel: signal cohort fetch failed: %s", exc)
        return {}
    if row is None:
        return {}
    # DL-10: returned_yes / returned_no were deferred per upgradespec
    # §D.2. The v1 flat columns are populated for the deferred signals
    # once we ship them; surface 0 today so downstream math doesn't
    # raise KeyError.
    out = dict(row)
    out.setdefault("returned_yes", 0)
    out.setdefault("returned_no", 0)
    return out


async def _fetch_explicit_cohort(
    org_id: str, interval: Any,
) -> dict[str, Any]:
    """Aggregate the explicit feedback (``user_feedback``) for
    ``org_id`` in the window ``interval`` (a Postgres interval
    literal string).

    Returns::

        {
            "total": int,
            "thumbs_up": int,
            "thumbs_down": int,
            "naive_satisfaction": float | None,
        }

    Best-effort: returns ``{}`` on DB error.
    """
    client = await _get_client()
    if client is None:
        return {}
    try:
        row = await client.fetchrow(
            """
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE rating > 0)::int AS thumbs_up,
                COUNT(*) FILTER (WHERE rating < 0)::int AS thumbs_down,
                AVG(rating)::float AS naive_satisfaction
              FROM user_feedback
             WHERE org_id = $1
               AND created_at >= NOW() - $2::interval
            """,
            org_id, str(interval),
        )
    except Exception as exc:
        logger.debug("user_intel: explicit cohort fetch failed: %s", exc)
        return {}
    if row is None:
        return {}
    out = dict(row)
    # Round the SQL-computed avg when present; otherwise
    # derive from thumbs_up/total so the dashboard's
    # ``thumbs_up_rate_naive`` field always has a value
    # (matches the test fixture's contract).
    if out.get("naive_satisfaction") is None:
        up = int(out.get("thumbs_up") or 0)
        total = int(out.get("total") or 0)
        out["naive_satisfaction"] = (
            round(up / total, 4) if total > 0 else None
        )
    else:
        out["naive_satisfaction"] = round(float(out["naive_satisfaction"]), 4)
    return out


# ── 1. RegenerationRateTracker ───────────────────────────────────────


class RegenerationRateTracker:
    """Track that the user clicked "regenerate" on a trace.

    A regenerate click is the single strongest *implicit*
    negative signal. The Cat 9 spec's failure-mode table
    calls out: "Regeneration rate is high (60% on technical
    queries). Segmentation is diagnostic, not vanity —
    split by query type, alert when regen rate > 50% on
    a specific query category."

    The alert is fired by the
    :class:`BehaviouralDashboard.cohort` aggregator when
    the cohort's regen rate exceeds 0.5.
    """

    name = "regeneration_tracker"

    async def track(
        self,
        org_id: str,
        *,
        trace_id: str,
        user_id: str,
        regenerated: bool = True,
    ) -> dict[str, Any]:
        if not trace_id or not isinstance(trace_id, str):
            return _bad_request_envelope(
                self.name, "trace_id is required"
            )
        if not user_id or not isinstance(user_id, str):
            return _bad_request_envelope(
                self.name, "user_id is required"
            )
        sig_id = await _upsert_signal_row(
            org_id, user_id, trace_id, {"regenerated": bool(regenerated)}
        )
        return _ok_envelope(
            self.name,
            {
                "signal_id": sig_id,
                "trace_id": trace_id,
                "user_id": user_id,
                "regenerated": bool(regenerated),
            },
        )


# ── 2. EditDistanceTracker ───────────────────────────────────────────


def _levenshtein(a: str, b: str) -> int:
    """Pure-Python Levenshtein distance. O(len(a) * len(b))
    time + space. For chat-message-sized strings (< 16k
    chars) this is fine."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    # Use the iterative two-row version to keep memory
    # to O(min(len(a), len(b))).
    if len(a) < len(b):
        a, b = b, a
    # Now ``len(a) >= len(b)``.
    previous_row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current_row = [i]
        for j, cb in enumerate(b, 1):
            insertions = previous_row[j] + 1
            deletions = current_row[j - 1] + 1
            substitutions = previous_row[j - 1] + (0 if ca == cb else 1)
            current_row.append(
                min(insertions, deletions, substitutions)
            )
        previous_row = current_row
    return previous_row[-1]


class EditDistanceTracker:
    """Compute edit distance between the model's response
    and the user's final text.

    Per the Behavioral Signals article (Tianpan.co, April
    2026): "Edit distance / correction-to-completion
    ratio has 0.81 correlation with human editing effort
    — the strongest automated proxy." We normalise to
    ``[0.0, 1.0]`` by dividing by ``max(len(a), len(b))``.

    The :meth:`compute_multimodal` method is a stub for
    v2 — it returns ``None`` until perceptual-hash + CLIP
    distance ship (per the appendix's open questions).
    """

    name = "edit_distance_tracker"

    async def compute(
        self,
        org_id: str,
        *,
        trace_id: str,
        user_id: str,
        model_response: str,
        final_text: str,
    ) -> dict[str, Any]:
        if not trace_id or not isinstance(trace_id, str):
            return _bad_request_envelope(
                self.name, "trace_id is required"
            )
        if not user_id or not isinstance(user_id, str):
            return _bad_request_envelope(
                self.name, "user_id is required"
            )
        if not isinstance(model_response, str) or not isinstance(
            final_text, str
        ):
            return _bad_request_envelope(
                self.name,
                "model_response and final_text must be strings",
            )
        # Cap inputs so the O(n*m) Levenshtein doesn't
        # blow up the request handler.
        model_response = model_response[:16384]
        final_text = final_text[:16384]
        if not model_response and not final_text:
            return _bad_request_envelope(
                self.name,
                "model_response and final_text cannot both be empty",
            )
        dist = _levenshtein(model_response, final_text)
        denom = max(len(model_response), len(final_text), 1)
        normalised = round(dist / denom, 4)
        sig_id = await _upsert_signal_row(
            org_id, user_id, trace_id, {"edit_distance": normalised}
        )
        return _ok_envelope(
            self.name,
            {
                "signal_id": sig_id,
                "trace_id": trace_id,
                "user_id": user_id,
                "edit_distance": normalised,
                "raw_distance": dist,
                "max_length": denom,
            },
        )

    async def compute_multimodal(
        self,
        org_id: str,
        *,
        trace_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        """Multimodal edit distance (image / audio / video).
        Per the appendix's open questions, this ships in v2
        with perceptual-hash + CLIP embedding distance.
        For v1, returns ``None`` distance with a clear
        ``unimplemented`` flag."""
        return _ok_envelope(
            self.name + "_multimodal",
            {
                "trace_id": trace_id,
                "user_id": user_id,
                "edit_distance": None,
                "method": None,
                "message": "multimodal edit distance ships in v2",
            },
        )


# ── 3. ReturnToFeatureTracker ────────────────────────────────────────


    # ponytail: ReturnToFeatureTracker removed per upgradespec §D.2


class AbandonmentTracker:
    """Track single-turn abandonment.

    Per the appendix: "a user who abandons after one
    turn is a strong negative signal — they did not
    engage with the response at all." The tracker
    writes ``abandoned_after_one = true`` to the signal
    row.
    """

    name = "abandonment_tracker"

    async def detect(
        self,
        org_id: str,
        *,
        trace_id: str,
        user_id: str,
        abandoned: bool = True,
    ) -> dict[str, Any]:
        if not trace_id or not isinstance(trace_id, str):
            return _bad_request_envelope(
                self.name, "trace_id is required"
            )
        if not user_id or not isinstance(user_id, str):
            return _bad_request_envelope(
                self.name, "user_id is required"
            )
        sig_id = await _upsert_signal_row(
            org_id, user_id, trace_id,
            {"abandoned_after_one": bool(abandoned)},
        )
        return _ok_envelope(
            self.name,
            {
                "signal_id": sig_id,
                "trace_id": trace_id,
                "user_id": user_id,
                "abandoned_after_one": bool(abandoned),
            },
        )


# ── 5. CopyPasteTracker ──────────────────────────────────────────────


    # ponytail: CopyPasteTracker removed per upgradespec §D.2


    # ponytail: RetryRephraseTracker removed per upgradespec §D.2


class BehaviouralDashboard:
    """Cohort-level aggregate of the 3 implicit signals +
    the explicit-feedback aggregate. The
    :meth:`cohort` method returns the dashboard payload
    matching the appendix's
    ``GET /intelligence/user/dashboard/cohort?cohort=power_users&window=30d``
    response shape.

    ponytail: per upgradespec §D.2 (Phase 1 cut), the 3
    signals (Regeneration, Edit, Abandonment) survive;
    CopyPaste + RetryRephrase + ReturnToFeature were
    removed. Fires the closed-loop hook when the
    regeneration rate exceeds
    :data:`DEFAULT_REGEN_ALERT_THRESHOLD`.
    """

    name = "behavioural_dashboard"

    async def cohort(
        self,
        org_id: str,
        *,
        cohort: str | None = None,
        window: str = "30d",
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '30d', '24h'",
            )

        signal_agg = await _fetch_signal_cohort(org_id, interval)
        explicit_agg = await _fetch_explicit_cohort(org_id, interval)

        if not signal_agg and not explicit_agg:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "cohort": cohort,
                    "window": window,
                    "n_users": 0,
                    "n_sessions": 0,
                    "regeneration_rate": None,
                    "edit_distance_median": None,
                    "7d_return_rate": None,
                    "abandonment_rate": None,
                    "thumbs_up_rate_naive": None,
                    "satisfaction_corrected": None,
                    "message": "no behavioural data",
                },
            )

        total = signal_agg.get("total", 0)
        regen_rate: float | None = (
            round(signal_agg.get("regen_count", 0) / total, 4)
            if total > 0
            else None
        )
        abandon_rate: float | None = (
            round(signal_agg.get("abandon_count", 0) / total, 4)
            if total > 0
            else None
        )
        # ``return_7d`` rate = (returned_yes) / (returned_yes + returned_no).
        r_yes = signal_agg.get("returned_yes", 0)
        r_no = signal_agg.get("returned_no", 0)
        return_rate: float | None = (
            round(r_yes / (r_yes + r_no), 4)
            if (r_yes + r_no) > 0
            else None
        )
        edit_mean: float | None = signal_agg.get(
            "edit_distance_mean"
        )
        explicit_agg.get("total", 0)
        thumbs_up = explicit_agg.get("thumbs_up", 0)
        naive: float | None = explicit_agg.get("naive_satisfaction")

        # The coverage-weighted satisfaction (per
        # :class:`SatisfactionSignalService`) is not
        # computed at the *cohort* level here — the
        # Bayesian correction is per-trace. We surface
        # the *naive* mean as a sanity check and let
        # the front-end drill into a specific trace for
        # the corrected value.
        satisfaction_corrected: float | None = naive

        # Fire the regen-rate alert.
        alert: str | None = None
        if regen_rate is not None and regen_rate > DEFAULT_REGEN_ALERT_THRESHOLD:
            alert = (
                f"Regeneration rate {regen_rate:.0%} exceeds the "
                f"{DEFAULT_REGEN_ALERT_THRESHOLD:.0%} threshold — "
                "consider segmenting by query type"
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "cohort": cohort,
                "window": window,
                "n_users": total,
                "n_sessions": total,
                "regeneration_rate": regen_rate,
                "edit_distance_median": (
                    round(edit_mean, 4) if edit_mean is not None else None
                ),
                "7d_return_rate": return_rate,
                "abandonment_rate": abandon_rate,
                "thumbs_up_rate_naive": naive,
                "thumbs_up_count": thumbs_up,
                "thumbs_down_count": explicit_agg.get("thumbs_down", 0),
                "satisfaction_corrected": (
                    round(satisfaction_corrected, 4)
                    if satisfaction_corrected is not None
                    else None
                ),
                "ttfa_mean_ms": (
                    round(signal_agg.get("ttfa_mean") or 0.0, 2)
                    if signal_agg
                    else None
                ),
                "alert": alert,
            },
        )
