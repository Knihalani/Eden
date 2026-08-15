"""Boolean/Categorical + User Feedback services (Cat 3) — real implementations.

Two services:

* :class:`BooleanCategoricalScore` — Langfuse-style non-
  continuous score types. ``score_type="boolean"`` maps
  ``value`` ∈ {``"true"``, ``"yes"``, ``"1"``} → ``1.0`` and
  {``"false"``, ``"no"``, ``"0"``} → ``0.0``; ``score_type=
  "categorical"`` returns ``0.5`` with a category-preserving
  rationale (categorical scores are not numeric on the
  0..1 scale; we use 0.5 as a neutral point so the row can
  be joined with continuous scores in aggregate queries).

  The :attr:`name` is ``"boolean_categorical"``.

* :class:`UserFeedbackService` — Langfuse / Lunary-style
  thumbs + rating + comment submission. At least one of
  ``thumbs``, ``rating``, or ``comment`` must be set (per the
  appendix failure modes). Persists to ``eval_user_feedback``.

  The :attr:`name`` is ``"eval_user_feedback"``.

Both services are re-runnable:

* BooleanCategoricalScore uses
  :func:`_delete_then_insert_boolean_categorical` keyed on
  ``(org_id, trace_id, score_type)`` so a trace can be
  re-evaluated with a different verdict.
* UserFeedbackService appends a row per submission (no
  dedup — the operator may want to capture multiple
  feedback signals for the same trace).

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    ALLOWED_THUMBS,
    RATING_MAX,
    RATING_MIN,
    _bad_request_envelope,
    _delete_then_insert_boolean_categorical,
    _insert_user_feedback,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


# Map of boolean truthy / falsy values to a normalised
# boolean. The set is intentionally conservative — the
# operator can extend it in a future iteration if more
# variants are needed.
_BOOLEAN_TRUE: frozenset[str] = frozenset(
    {"true", "yes", "1", "t", "y", "pass", "success", "ok"},
)
_BOOLEAN_FALSE: frozenset[str] = frozenset(
    {"false", "no", "0", "f", "n", "fail", "failure", "bad"},
)


# ── 1. BooleanCategoricalScore ───────────────────────────────────────


class BooleanCategoricalScore:
    """Langfuse-style boolean / categorical score.

    Public method :meth:`evaluate` returns the live envelope
    on success, or a live "bad_request" envelope on invalid
    ``score_type``.
    """

    name = "boolean_categorical"

    async def evaluate(
        self,
        org_id: str,
        *,
        score_type: str,  # "boolean" or "categorical"
        value: str,
    ) -> dict[str, Any]:
        # 1. Validate score_type.
        if score_type not in ("boolean", "categorical"):
            return _bad_request_envelope(
                self.name,
                (
                    f"unknown score_type {score_type!r}; "
                    "expected 'boolean' or 'categorical'"
                ),
            )
        if not isinstance(value, str) or not value.strip():
            return _bad_request_envelope(
                self.name,
                "value must be a non-empty string",
            )
        value = value.strip()[:64]

        # 2. Map to a 0..1 score.
        if score_type == "boolean":
            normalised = value.lower()
            if normalised in _BOOLEAN_TRUE:
                score: float = 1.0
                rationale: str = f"boolean: true ({value!r})"
            elif normalised in _BOOLEAN_FALSE:
                score = 0.0
                rationale = f"boolean: false ({value!r})"
            else:
                return _bad_request_envelope(
                    self.name,
                    (
                        f"unknown boolean value {value!r}; "
                        f"expected one of {sorted(_BOOLEAN_TRUE | _BOOLEAN_FALSE)}"
                    ),
                )
        else:  # categorical
            # Categorical: 0.5 neutral. The category is
            # preserved in the rationale so the row can be
            # filtered / grouped by category.
            score = 0.5
            rationale = f"categorical: {value}"

        # 3. Persist (best-effort, delete-then-insert on
        # (org_id, trace_id, score_type)). NOTE: the public
        # method doesn't take a ``trace_id`` in v1; we use
        # the synthetic key ``"default"`` so the row is
        # re-runnable in case the operator calls evaluate
        # multiple times with the same score_type.
        # A future iteration can add ``trace_id`` to the
        # public method signature.
        await _delete_then_insert_boolean_categorical(
            org_id, "default", score_type,
            value=value, rationale=rationale,
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "score_type": score_type,
                "value": value,
                "score": round(float(score), 4),
                "rationale": rationale,
            },
        )


# ── 2. UserFeedbackService ──────────────────────────────────────────


class UserFeedbackService:
    """Langfuse / Lunary-style user feedback submission.

    Public method :meth:`submit_thumbs_rating` returns the
    live envelope on success, or a live "bad_request" envelope
    when none of ``thumbs``/``rating``/``comment`` are set or
    when ``thumbs``/``rating`` are out of domain.
    """

    name = "eval_user_feedback"

    async def submit_thumbs_rating(
        self,
        org_id: str,
        *,
        trace_id: str,
        thumbs: str | None = None,
        rating: int | None = None,
        comment: str | None = None,
    ) -> dict[str, Any]:
        # 1. Validate trace_id.
        if not trace_id or not isinstance(trace_id, str):
            return _bad_request_envelope(
                self.name,
                "trace_id must be a non-empty string",
            )
        trace_id = trace_id.strip()[:128]

        # 2. At least one of thumbs/rating/comment is required.
        if thumbs is None and rating is None and not (
            comment and comment.strip()
        ):
            return _bad_request_envelope(
                self.name,
                (
                    "at least one of thumbs, rating, or comment "
                    "must be set"
                ),
            )

        # 3. Validate thumbs and rating.
        if thumbs is not None and thumbs not in ALLOWED_THUMBS:
            return _bad_request_envelope(
                self.name,
                (
                    f"invalid thumbs {thumbs!r}; expected "
                    f"one of {list(ALLOWED_THUMBS)}"
                ),
            )
        if rating is not None and not (
            isinstance(rating, int) and RATING_MIN <= rating <= RATING_MAX
        ):
            return _bad_request_envelope(
                self.name,
                (
                    f"invalid rating {rating!r}; expected integer in "
                    f"[{RATING_MIN}, {RATING_MAX}]"
                ),
            )
        if comment is not None and not isinstance(comment, str):
            return _bad_request_envelope(
                self.name,
                "comment must be a string when set",
            )

        # 4. Persist (best-effort, append-only row).
        await _insert_user_feedback(
            org_id,
            trace_id=trace_id,
            user_id=None,  # not exposed in v1 API
            thumbs=thumbs,
            rating=rating,
            comment=comment,
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "trace_id": trace_id,
                "thumbs": thumbs,
                "rating": rating,
                "comment": comment,
                "status": "received",
            },
        )
