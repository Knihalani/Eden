"""AutoRevertEngine — 3-strategy auto-revert.

Three revert strategies, picked automatically by PR state:

1. ``close_pr`` — if the PR hasn't been merged yet (i.e., the
   regression was detected *before* merge by the patch's own
   post-merge simulation), just close it. No git action.
2. ``revert_pr`` — create a new PR with
   ``gh pr revert <pr_number>`` (or the GitLab/Bitbucket
   equivalent). The revert goes through the normal
   CODEOWNERS review. Default strategy.
3. ``revert_branch`` — ``git revert <merge_sha>`` on a new
   branch ``eden/revert-<pr_short>`` and open a revert PR.
   Used only when the repo's history is non-linear
   (squash-merged PRs, rebased merges) and ``revert_pr``
   would conflict.

All three strategies **never force-push, never rewrite
history, never delete branches, never delete the original
PR**. Requires ``auto_revert_enabled=true`` AND
``min_post_merge_window_hours`` elapsed AND the post-merge
window shows regression. Persists to ``revert_events`` with
the strategy, the regression evidence, the revert PR URL, and
the post-revert verification (the same 4-window monitor
re-runs against the revert).

STUB mode (Gate 4b — manual revert) returns the live envelope
with the chosen strategy. The real implementation will call
the GitHub API to actually create the revert PR.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _check_two_stage_optin, _new_id, _ok_envelope

logger = logging.getLogger(__name__)


# The 3 strategies + the conditions that select each.
STRATEGY_CLOSE_PR = "close_pr"
STRATEGY_REVERT_PR = "revert_pr"
STRATEGY_REVERT_BRANCH = "revert_branch"


def _pick_strategy(pr_state: str, history_is_linear: bool) -> str:
    """The strategy selector — pure function, no side-effects."""
    if pr_state in {"open", "closed"}:
        return STRATEGY_CLOSE_PR
    if history_is_linear:
        return STRATEGY_REVERT_PR
    return STRATEGY_REVERT_BRANCH


class AutoRevertEngine:
    """Revert a merged PR using one of the 3 strategies."""

    name = "auto_revert_engine"

    async def revert(
        self,
        org_id: str,
        pr_id: str,
        policy: dict[str, Any],
        pr_state: str = "merged",
        history_is_linear: bool = True,
        regression_evidence: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Pick the strategy + (in Gate 4b) execute the revert.

        STUB: returns the live envelope with the chosen
        strategy. The two-stage opt-in
        (``code_change_enabled`` + ``auto_revert_enabled``) is
        checked FIRST.
        """
        optin = _check_two_stage_optin(self.name, policy, "revert_pr")
        if optin is not None:
            return optin
        strategy = _pick_strategy(pr_state, history_is_linear)
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "pr_id": pr_id,
                "strategy": strategy,
                "revert_id": _new_id("rev"),
                "pr_state": pr_state,
                "history_is_linear": history_is_linear,
                "regression_evidence": regression_evidence or {},
                "message": (
                    "Stub strategy selection — Gate 4b will "
                    "execute the revert via the GitHub API."
                ),
            },
        )
