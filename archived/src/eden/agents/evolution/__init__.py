"""Evolution engine for Eden's agent prompts.

The evolution components drive the closed-loop flywire that turns
judge-score signals into prompt variants and canary experiments.
Two main actors:

* :class:`JudgeScorePromptEvolver` — reads ``judge_scores`` joined
  to ``telemetry_events`` (Phase 1 ingest), groups by
  ``(agent, judge)``, and for every degraded pair calls the LLM to
  generate a new prompt variant registered as inactive (so it can
  be A/B tested before promotion).
* :class:`PromptEvolvers` — wraps the canary-creation flow. After
  the judge-driven evolver inserts a new variant, this component
  enrolls it in a canary at ``settings.evolver_auto_canary_pct``
  traffic and writes an ``evolver.auto_canary_created`` entry to
  ``org_audit_log``.

The two-stage wiring (JudgeScorePromptEvolver → PromptEvolvers) is
the entry point for the Phase 7.2b–7.2c closed-loop work.
"""

from eden.agents.evolution.components import (
    EvolutionComponent,
    JudgeScorePromptEvolver,
    PromptEvolvers,
)

__all__ = [
    "EvolutionComponent",
    "JudgeScorePromptEvolver",
    "PromptEvolvers",
]
