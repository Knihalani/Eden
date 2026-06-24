"""Onboarding services — D.14 cold-start UX (upgradespec §10).

The 7-step state machine (per spec §10.1):

    install → org → connect → wait → done → tour → autonomous

* :class:`OnboardingStateMachine` — the per-org state row +
  step transitions + milestone recording + cat-enablement
  toggles. Best-effort: every fetcher returns sensible
  defaults when the DB is unreachable.
* :data:`ONBOARDING_V2_CUTOVER` — orgs created BEFORE this
  date get the legacy UX (no banner, no state machine).
  Per the plan's "new-orgs-only rollout flag" check.
"""

from eden.services.onboarding.state_machine import (
    MILESTONE_ADVANCES,
    ONBOARDING_STEPS,
    ONBOARDING_V2_CUTOVER,
    OnboardingStateMachine,
    OnboardingStep,
    StateRow,
    get_state_machine,
)

__all__ = [
    "MILESTONE_ADVANCES",
    "ONBOARDING_STEPS",
    "ONBOARDING_V2_CUTOVER",
    "OnboardingStateMachine",
    "OnboardingStep",
    "StateRow",
    "get_state_machine",
]
