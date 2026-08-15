"""User feedback (Cat 9 v0).

:class:`UserFeedbackService` — explicit feedback (thumbs
up/down, rating, comment). Backed by the ``user_feedback``
table from migration 020.

Per the appendix:

* **Explicit feedback is a 1-3% signal.** The 2026
  user-feedback research is unambiguous: thumbs-up/down
  alone is a *bad* satisfaction signal. The
  :class:`SatisfactionSignalService` (next module) is
  the *real* signal — it weighs explicit by 0.03 and
  implicit by 0.97 (the appendix's default).
* ``submit_thumbs`` accepts both the short form
  (``"up"``/``"down"``) and the long form
  (``"thumbs_up"``/``"thumbs_down"``) plus the SDK
  conventions (``"positive"``/``"negative"``,
  ``"+1"``/``"-1"``). Anything else is a bad request.
* ``get_feedback_for_trace`` returns the explicit-feedback
  count + a derived *naive* satisfaction mean. The
  *corrected* mean lives in
  :class:`SatisfactionSignalService` and is the answer
  you should actually trust.

The package degrades gracefully — an empty ``user_feedback``
table returns a "no feedback" envelope.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    _bad_request_envelope,
    _get_client,
    _new_id,
    _ok_envelope,
    _parse_thumbs,
)

logger = logging.getLogger(__name__)


#: The default *weight* assigned to a single explicit
#: feedback event in the coverage-weighted satisfaction
#: aggregate. Per the 2026 user-feedback research, the
#: explicit feedback coverage is 1-3% — so the implicit
#: signal (97%) carries 32× the weight of one explicit
#: event. This is the *per-event* weight; the
#: coverage-weight uses the *count* of events vs. the
#: total interactions to compute the explicit signal
#: weight.
DEFAULT_EXPLICIT_WEIGHT: float = 0.03


class UserFeedbackService:
    """Explicit feedback (thumbs-up/down, rating, comment).

    The primary *write* path for Cat 9's explicit-feedback
    substrate. Reads happen via :meth:`get_feedback_for_trace`
    and (the canonical answer) via
    :class:`SatisfactionSignalService.compute`, which joins
    explicit feedback with the 7 implicit behavioural
    signals.
    """

    name = "user_feedback"

    async def submit_thumbs(
        self,
        org_id: str,
        *,
        trace_id: str,
        thumbs: str,
        user_id: str | None = None,
        comment: str | None = None,
        rating: int | None = None,
    ) -> dict[str, Any]:
        if not trace_id or not isinstance(trace_id, str):
            return _bad_request_envelope(
                self.name, "trace_id is required"
            )
        norm = _parse_thumbs(thumbs)
        if norm is None:
            return _bad_request_envelope(
                self.name,
                "thumbs must be 'up'/'down' (or 'thumbs_up'/"
                "'thumbs_down'/'positive'/'negative'/'+1'/'-1')",
            )
        # ``rating`` is an optional 1-5 star rating (the
        # column exists in the schema but the appendix
        # treats it as a future-facing extension; for the
        # v1 surface we only validate it's a sensible int).
        if rating is not None and (
            not isinstance(rating, int) or rating < 1 or rating > 5
        ):
            return _bad_request_envelope(
                self.name, "rating must be 1-5"
            )
        if comment is not None:
            if not isinstance(comment, str):
                return _bad_request_envelope(
                    self.name, "comment must be a string"
                )
            comment = comment[:2048]

        feedback_id = _new_id("fb")
        client = await _get_client()
        if client is not None:
            try:
                await client.execute(
                    """
                    INSERT INTO user_feedback
                        (id, org_id, user_id, trace_id, thumbs, rating, comment)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    """,
                    feedback_id,
                    org_id,
                    user_id,
                    trace_id,
                    norm,
                    rating,
                    comment,
                )
            except Exception as exc:
                logger.debug(
                    "user_intel: feedback insert failed: %s", exc
                )

        return _ok_envelope(
            self.name,
            {
                "feedback_id": feedback_id,
                "org_id": org_id,
                "trace_id": trace_id,
                "user_id": user_id,
                "thumbs": norm,
                "rating": rating,
                "comment": comment,
                "explicit_weight": DEFAULT_EXPLICIT_WEIGHT,
            },
        )

    async def get_feedback_for_trace(
        self,
        org_id: str,
        *,
        trace_id: str,
    ) -> dict[str, Any]:
        if not trace_id or not isinstance(trace_id, str):
            return _bad_request_envelope(
                self.name, "trace_id is required"
            )

        client = await _get_client()
        if client is None:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "trace_id": trace_id,
                    "thumbs_up": 0,
                    "thumbs_down": 0,
                    "naive_satisfaction": None,
                    "feedback": [],
                    "message": "no feedback data",
                },
            )

        try:
            rows = await client.fetch(
                """
                SELECT id, user_id, thumbs, rating, comment, created_at
                  FROM user_feedback
                 WHERE org_id = $1 AND trace_id = $2
                 ORDER BY created_at ASC
                """,
                org_id,
                trace_id,
            )
        except Exception as exc:
            logger.debug("user_intel: feedback fetch failed: %s", exc)
            rows = []

        thumbs_up = 0
        thumbs_down = 0
        feedback: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r) if not isinstance(r, dict) else r
            t = d.get("thumbs")
            if t == "up":
                thumbs_up += 1
            elif t == "down":
                thumbs_down += 1
            feedback.append(
                {
                    "feedback_id": d.get("id"),
                    "user_id": d.get("user_id"),
                    "thumbs": t,
                    "rating": d.get("rating"),
                    "comment": d.get("comment"),
                    "created_at": (
                        d.get("created_at").isoformat()
                        if hasattr(d.get("created_at"), "isoformat")
                        else str(d.get("created_at"))
                    ),
                }
            )

        total = thumbs_up + thumbs_down
        naive: float | None = (
            round(thumbs_up / total, 4) if total > 0 else None
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "trace_id": trace_id,
                "thumbs_up": thumbs_up,
                "thumbs_down": thumbs_down,
                "naive_satisfaction": naive,
                "feedback": feedback,
                "count": len(feedback),
                # The corrected satisfaction is computed by
                # :class:`SatisfactionSignalService`. We
                # don't return it from this endpoint — the
                # spec separates the two surfaces.
            },
        )
