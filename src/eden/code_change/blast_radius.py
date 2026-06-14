"""BlastRadiusAnalyzer — compute a 0-1 blast-radius score + affected ids.

The 2 signals combined (per the v1.6 cat spec):

1. **Static analysis** (40% weight) — the tree-sitter call graph:
   how many distinct functions/callers does the patched code
   touch? A patch in a leaf function scores 0.05; a patch in a
   shared utility scores 0.40; a patch in the rate-limiter
   middleware scores 0.95.
2. **Dynamic analysis** (60% weight) — the telemetry: how many
   distinct traces in the last 30 days executed this code path?
   A patch in a rarely-called function scores 0.05; a patch in
   the main chat-completions handler scores 0.95.

Blocks PR creation if ``blast_radius_score > max_blast_radius_score``.
The 40/60 weighting matches the Cat 2 RCA confidence adjustment
(``+0.05 multi-signal``).

STUB mode returns the not-implemented envelope with
``gate=2_blocked`` (the static + dynamic score computation
requires the Gate-2 work). The :class:`PatchGenerator` still
calls into the analyzer; the analyzer returns the stub
envelope so the rest of the pipeline can short-circuit.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _new_id, _not_implemented_envelope

logger = logging.getLogger(__name__)


# The 40/60 weighting is the canonical signal mix per the
# v1.6 cat spec. Exposed as a constant for tests + downstream
# services that need to recompute the score from raw signals.
STATIC_WEIGHT = 0.4
DYNAMIC_WEIGHT = 0.6


class BlastRadiusAnalyzer:
    """Compute the 0-1 blast-radius score for a proposed patch."""

    name = "blast_radius_analyzer"

    async def analyze(
        self,
        org_id: str,
        diff: str,
        repo_id: str,
    ) -> dict[str, Any]:
        """Return the score + the list of affected trace / agent / user ids.

        STUB: returns the Gate-2-blocked envelope. The real
        implementation (Gate 2) will read the tree-sitter call
        graph for the static score and the ``telemetry_events``
        table for the dynamic score, then combine per the
        40/60 weighting.
        """
        return _not_implemented_envelope(
            self.name,
            message=(
                "Blast-radius scoring requires the tree-sitter call "
                "graph (static) + the last-30-days telemetry scan "
                "(dynamic). Both ship in Gate 2. STUB returns a "
                "blocked envelope so the PatchGenerator can "
                "short-circuit before any side-effect."
            ),
            gate="2_blocked",
            data={
                "blast_radius_score": None,
                "affected_trace_ids": [],
                "affected_agent_ids": [],
                "static_weight": STATIC_WEIGHT,
                "dynamic_weight": DYNAMIC_WEIGHT,
                "stub_id": _new_id("blast_stub"),
            },
        )
