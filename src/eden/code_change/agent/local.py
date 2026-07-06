"""LocalPRAgent — the no-credentials fallback.

When ``OPENHANDS_API_KEY`` is unset (dev / CI / on-prem),
this implementation returns a :class:`PRResult` with
``kind="report_only"`` and a helpful reason. It does
NOT attempt to fabricate a diff — the discipline
layer's confidence gate is the only thing protecting
the system from a fabricated-PR flood, and an
ungrounded agent output would bypass that.

The local agent still produces a structured body so
the user gets a useful report when the gate clears
but OpenHands isn't available:

* A summary of the evidence the gate saw.
* The files the graph (local fallback) surfaced.
* A note explaining why this is a report-only path.
"""

from __future__ import annotations

import logging
from typing import Any

from .openhands import PRCandidate, PRResult

logger = logging.getLogger(__name__)


class LocalPRAgent:
    """The no-credentials fallback PR agent."""

    name: str = "local"

    async def run(
        self,
        candidate: PRCandidate,
        *,
        decision: Any | None = None,
    ) -> PRResult | None:
        """Return a structured report-only payload.

        The ``body`` field is a markdown summary that
        the caller can render to the user.
        """
        parts: list[str] = [
            f"### Eden report — {candidate.target_kind}",
            "",
            candidate.incident_summary or "(no summary provided)",
            "",
        ]
        if candidate.graph_files:
            parts.append("#### Likely-affected files")
            parts.extend(f"- `{p}`" for p in candidate.graph_files[:20])
            parts.append("")
        if candidate.evidence_refs:
            parts.append("#### Evidence")
            parts.extend(f"- `{e}`" for e in candidate.evidence_refs[:10])
            parts.append("")
        parts.append(
            "Eden's autonomous PR agent is not configured "
            "for this environment. Set `OPENHANDS_API_KEY` "
            "to enable code-fix PR generation; this is "
            "intentionally a report-only path so Eden "
            "doesn't open ungrounded PRs."
        )
        return PRResult(
            kind="report_only",
            reason="no_openhands_key",
            body="\n".join(parts),
            title="",
            diff="",
        )
