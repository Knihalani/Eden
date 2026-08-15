"""Trace-quality hooks + DB query layer (Cat 15/17/22 wiring, spec §12).

The ``eden.observability.trace_quality`` package owns:

* :mod:`.hooks` — hot-path ``evaluate_trajectory_step`` that
  the ``POST /v1/guardrails/trajectory/check`` route calls.
* :mod:`.queries` — async DB read/write helpers for the
  ``trace_*_reports`` and ``tenant_guardrail_action_config``
  tables (migrations 068-073).

The sidecar worker package lives at
``eden.observability.quality_pipeline`` (separate so the
hot-path and the post-hoc compute can scale independently).
"""

from .hooks import (
    ACTION_CLASS_DEFAULTS,
    ACTION_PRECEDENCE,
    evaluate_trajectory_step,
)
from .queries import (
    fetch_efficiency_report,
    fetch_guardrail_actions,
    fetch_loop_report,
    fetch_pending_actions,
    fetch_quality_report,
    fetch_reasoning_report,
    fetch_tenant_action_config,
    set_action_applied,
    set_tenant_action_config,
)

__all__ = [
    "ACTION_CLASS_DEFAULTS",
    "ACTION_PRECEDENCE",
    "evaluate_trajectory_step",
    "fetch_efficiency_report",
    "fetch_loop_report",
    "fetch_quality_report",
    "fetch_reasoning_report",
    "fetch_guardrail_actions",
    "fetch_pending_actions",
    "set_action_applied",
    "fetch_tenant_action_config",
    "set_tenant_action_config",
]
