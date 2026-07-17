"""ArtifactComposer — dedupe triggers and enforce max promoted Artifacts."""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from eden.config import get_settings
from eden.nudges.models import Nudge

logger = logging.getLogger(__name__)


def _trigger_fingerprint(trigger: dict[str, Any]) -> str:
    blob = json.dumps(trigger, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


class ArtifactComposer:
    """Merge overlapping Artifacts and cap promoted count."""

    def compose(
        self,
        nudges: list[Nudge],
        *,
        max_promoted: int | None = None,
    ) -> list[Nudge]:
        settings = get_settings()
        cap = max_promoted if max_promoted is not None else settings.max_promoted_artifacts
        promoted = [n for n in nudges if n.mode == "promoted"]
        shadow = [n for n in nudges if n.mode != "promoted"]

        merged: dict[str, Nudge] = {}
        for n in promoted:
            fp = _trigger_fingerprint(n.trigger)
            existing = merged.get(fp)
            if existing is None:
                merged[fp] = n
                continue
            if len(n.content) > len(existing.content):
                merged[fp] = n

        ranked = sorted(
            merged.values(),
            key=lambda n: float((n.evidence or {}).get("value_score") or 0.0),
            reverse=True,
        )
        kept = ranked[:cap]
        return kept + shadow

    def merge_content(self, a: Nudge, b: Nudge) -> str:
        if a.content == b.content:
            return a.content
        return f"{a.content}\n\n{b.content}"[:4000]
