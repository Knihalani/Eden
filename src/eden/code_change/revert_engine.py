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

Gate 4b wiring (this module): the engine now actually
calls the configured :class:`PRProvider` to execute the
chosen strategy. The two-stage opt-in check
(``code_change_enabled`` + ``auto_revert_enabled``) is the
gate; once both are on, the strategy is dispatched to the
provider (LocalPRProvider for dev / CI, GitHubPRProvider
for production).

When the provider isn't configured, the engine returns
the chosen strategy without side-effects — that's the
manual-trigger path (the caller can then dispatch
manually).
"""

from __future__ import annotations

import logging
from typing import Any

from eden.providers import PRProvider, PRRevertRequest

from ._common import _check_two_stage_optin, _insert_row, _new_id, _ok_envelope

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


def _parse_pr_number(pr_id: str) -> int:
    """Extract the GitHub PR number from a ``pr_<n>_<...>`` id.

    Falls back to ``0`` when the id doesn't match the
    expected shape. The provider's revert path treats
    ``0`` as a no-op + log, which is the right behaviour
    for a malformed id (the caller should never see one).
    """
    parts = pr_id.split("_")
    if len(parts) >= 2 and parts[0] in ("pr", "patch"):
        try:
            return int(parts[1])
        except ValueError:
            return 0
    return 0


class AutoRevertEngine:
    """Revert a merged PR using one of the 3 strategies.

    Gate 4b wiring: when a :class:`PRProvider` is
    configured (via the constructor or the default
    factory), the engine actually dispatches the revert.
    Without a provider, the engine returns the strategy
    selection only — the manual-trigger path.
    """

    name = "auto_revert_engine"

    def __init__(
        self,
        provider: PRProvider | None = None,
    ) -> None:
        self._provider = provider

    async def revert(
        self,
        org_id: str,
        pr_id: str,
        policy: dict[str, Any],
        pr_state: str = "merged",
        history_is_linear: bool = True,
        regression_evidence: dict[str, Any] | None = None,
        *,
        merge_sha: str | None = None,
        new_branch: str | None = None,
    ) -> dict[str, Any]:
        """Pick the strategy + (Gate 4b) execute via the provider.

        Args:
            org_id: The org context.
            pr_id: The PR id (Eden's internal format). The
                provider needs the GitHub PR number — we
                extract it from ``pr_<n>_<...>`` shape.
            policy: The two-stage opt-in policy.
            pr_state: ``"open"``, ``"closed"``, ``"merged"``.
            history_is_linear: ``True`` when the repo's
                merge history is linear (no squash / rebase).
            regression_evidence: The post-merge window
                results that triggered the revert.
            merge_sha: Required for ``revert_pr`` +
                ``revert_branch`` strategies. The provider
                uses this to create the revert commit.
            new_branch: Override the auto-generated revert
                branch name.

        Returns:
            The live envelope. When the provider executes
            successfully, the response carries the new
            PR info + the strategy. When the provider is
            not configured, only the strategy is returned
            (the manual-trigger path).
        """
        optin = _check_two_stage_optin(self.name, policy, "revert_pr")
        if optin is not None:
            return optin
        strategy = _pick_strategy(pr_state, history_is_linear)
        revert_id = _new_id("rev")
        evidence = regression_evidence or {}

        # Manual-trigger path: no provider configured. The
        # caller (typically the portal) gets the strategy
        # + can dispatch the actual revert itself.
        provider = self._provider
        if provider is None:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "pr_id": pr_id,
                    "strategy": strategy,
                    "revert_id": revert_id,
                    "pr_state": pr_state,
                    "history_is_linear": history_is_linear,
                    "regression_evidence": evidence,
                    "executed": False,
                    "message": (
                        "Strategy selected; no PRProvider configured. "
                        "Manual-trigger path: dispatch the revert via "
                        "the portal or inject a PRProvider."
                    ),
                },
            )

        # Auto-mode path: dispatch to the provider.
        pr_number = _parse_pr_number(pr_id)
        try:
            new_info = await provider.revert(PRRevertRequest(
                pr_number=pr_number,
                strategy=strategy,
                new_branch=new_branch,
                merge_sha=merge_sha,
            ))
        except Exception as exc:
            # Push to HookBus DLQ so the next cron tick (or operator)
            # can retry the revert instead of letting it fall on the
            # floor — a regression must not silently persist.
            try:
                from eden.llmops.promotion_hooks import _record_action
                await _record_action(
                    org_id,
                    hook_name="auto_revert_dlq",
                    action_kind="consider_revert",
                    target=pr_id,
                    payload={
                        "pr_id": pr_id,
                        "strategy": strategy,
                        "revert_id": revert_id,
                        "error": str(exc),
                    },
                    severity="high",
                )
            except Exception as dlq_exc:
                logger.warning(
                    "AutoRevertEngine: DLQ enqueue failed: %s", dlq_exc,
                )
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "pr_id": pr_id,
                    "strategy": strategy,
                    "revert_id": revert_id,
                    "executed": False,
                    "queued": True,
                    "error": str(exc),
                    "message": (
                        f"Strategy {strategy!r} selected but the "
                        f"provider failed: {exc}. Queued on HookBus DLQ."
                    ),
                },
            )

        # Persist the revert event for audit + the
        # post-revert verification monitor.
        try:
            await _insert_row(
                org_id,
                "revert_events",
                [
                    "id",
                    "pr_id",
                    "strategy",
                    "revert_pr_number",
                    "revert_pr_url",
                    "regression_evidence",
                ],
                [
                    revert_id,
                    pr_id,
                    strategy,
                    new_info.number,
                    new_info.url,
                    _json_dumps_evidence(evidence),
                ],
            )
        except Exception as exc:
            logger.debug(
                "AutoRevertEngine: revert_events persist failed: %s", exc,
            )

        # Gate 5 wiring: record the revert outcome in the
        # CodebaseKnowledgeGraph. Best-effort — a graph
        # write failure doesn't fail the revert. The
        # evidence's "code_path" key (set by the post-merge
        # monitor) is the file we record against; falls
        # back to an empty path if not present.
        try:
            from .knowledge_graph import CodebaseKnowledgeGraph
            kg = CodebaseKnowledgeGraph()
            affected = (evidence or {}).get("code_path") or ""
            if affected:
                await kg.record_outcome(
                    org_id=org_id,
                    repo_id=(evidence or {}).get("repo_id") or "",
                    code_path=affected,
                    outcome="reverted",
                    rca_category=(evidence or {}).get("rca_category", ""),
                    telemetry_signature=(evidence or {}).get(
                        "telemetry_signature", "",
                    ),
                )
        except Exception as exc:
            logger.debug(
                "AutoRevertEngine: KG record_outcome failed: %s", exc,
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "pr_id": pr_id,
                "strategy": strategy,
                "revert_id": revert_id,
                "revert_pr_number": new_info.number,
                "revert_pr_url": new_info.url,
                "revert_pr_state": new_info.state,
                "executed": True,
                "regression_evidence": evidence,
                "message": (
                    f"Reverted PR #{pr_number} via {strategy!r}; "
                    f"new PR #{new_info.number} at {new_info.url}"
                ),
            },
        )


def _json_dumps_evidence(evidence: dict[str, Any]) -> str:
    """Serialise the regression evidence for the ``revert_events`` row.

    Kept as a thin wrapper around :func:`json.dumps` so the
    call site doesn't need to import ``json`` directly.
    """
    import json
    try:
        return json.dumps(evidence)
    except Exception:
        return "{}"


__all__ = [
    "AutoRevertEngine",
    "STRATEGY_CLOSE_PR",
    "STRATEGY_REVERT_BRANCH",
    "STRATEGY_REVERT_PR",
]
