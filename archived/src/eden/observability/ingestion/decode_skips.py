"""Accounting for sub-items a decoder skips as unparseable.

Every decoder in this package walks a batch body and steps past entries
it cannot make sense of:

    for span in ss.get("spans") or []:
        if not isinstance(span, dict):
            continue

That ``continue`` is the right behaviour — one malformed span should not
cost the client the whole batch — but as written it was unobservable.
There was no log at any level and no counter, and the response is built
from the *post-skip* list::

    accepted=result.get("accepted", len(events))

so a client that sent 100 spans of which 40 were malformed was told 60
accepted out of 60. Partial loss and total success were the same wire
answer, in both directions: the sender could not tell it was dropping
data, and the operator could not see a schema drift chewing through a
fixed fraction of every batch.

This module keeps that accounting in one place so the eleven-odd skip
sites stay consistent, and so ``record_drop``'s closed vocabulary is
applied identically at each.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class SkipTally:
    """Counts skipped sub-items during one decode, reported once at the end.

    Per-item logging would turn a single bad batch into hundreds of lines,
    so callers ``add()`` per skip and ``report()`` once — one aggregate
    log line and one counter increment carrying the total.
    """

    __slots__ = ("_counts",)

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}

    def add(self, kind: str) -> None:
        """Record one skipped sub-item of ``kind`` (e.g. ``"span"``)."""
        self._counts[kind] = self._counts.get(kind, 0) + 1

    @property
    def total(self) -> int:
        return sum(self._counts.values())

    def report(self, source_format: str, *, kept: int) -> None:
        """Emit one log line and one drop count for everything skipped.

        ``kept`` is the number of events the decode is about to return,
        included so the log carries the ratio rather than a bare count —
        "3 skipped" reads very differently at kept=1000 than at kept=0.
        """
        total = self.total
        if total <= 0:
            return
        try:
            from eden.observability.drop_metrics import record_drop

            record_drop("ingest", "malformed", float(total))
        except Exception:  # noqa: BLE001 — never fail a decode over metrics
            pass
        breakdown = ", ".join(
            f"{n} {kind}" for kind, n in sorted(self._counts.items())
        )
        logger.warning(
            "ingest %s: skipped %d unparseable sub-item(s) (%s); %d event(s) "
            "kept. The client is told only about the kept events, so this "
            "loss is invisible to the sender.",
            source_format,
            total,
            breakdown,
            kept,
        )


def is_mapping(value: Any) -> bool:
    """``isinstance(value, dict)``, named for use at skip sites."""
    return isinstance(value, dict)
