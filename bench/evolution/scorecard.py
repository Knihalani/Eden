"""Evolution scorecard metrics — thin re-export for the nightly runner.

Canonical implementation lives in ``eden.llmops.evolution_scorecard`` so the
production API image does not need the ``bench/`` tree.
"""

from __future__ import annotations

from eden.llmops.evolution_scorecard import run_scorecard

__all__ = ["run_scorecard"]
