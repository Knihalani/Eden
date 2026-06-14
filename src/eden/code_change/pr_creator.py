"""PRCreator — open a real PR against the customer's repo.

Creates a branch (``eden/auto-fix-<trace_id_short>``), commits
the patch (signed commit via the GitHub App's bot identity),
opens a PR with:

* **Title:** ``[Eden Agent] Fix: <short description>`` (the
  agent's persona, not ``"[Eden] Auto-fix"`` — Eden is a team
  member, not a bot).
* **Body:** the 4-paragraph explanation (from
  :class:`PRExplanationService`), the test results, the
  blast-radius, the quality score, the cost-savings
  prediction, and a "Eden will auto-revert this PR <hours>
  after merge if the following metrics regress by <pct>%"
  callout.
* **Labels:** ``eden-agent``, ``auto-revertable`` (if
  ``auto_revert_enabled=true``), ``needs-review``, the RCA
  category.
* **Reviewers:** ``required_reviewers`` from the policy + the
  CODEOWNERS for the touched files + the user who originated
  the trace.

STUB mode (Gate 4a — manual end-to-end) returns the
not-implemented envelope. The user-triggered "Propose code
fix" + "Open PR" flow opens a real PR against a test repo
once Gate 4a ships.

**Provider delegation (v1.7).** The creator now exposes a
``self._provider: PRProvider`` (from
:mod:`eden.providers.pr`). The Cat 23 STUB surface
delegates the actual ``create_pr`` call to the provider
so the agent-suggest flow + the Cat 23 surface share the
same write-side abstraction.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.providers import PRCreateRequest, PRProvider, get_default_pr_provider

from ._common import _check_two_stage_optin, _new_id, _not_implemented_envelope

logger = logging.getLogger(__name__)


class PRCreator:
    """Create a branch + commit + PR on the customer's repo."""

    name = "pr_creator"

    def __init__(
        self,
        provider: PRProvider | None = None,
    ) -> None:
        self._provider = provider or get_default_pr_provider()

    async def create(
        self,
        org_id: str,
        patch_id: str,
        policy: dict[str, Any],
        *,
        req: PRCreateRequest | None = None,
    ) -> dict[str, Any]:
        """Create the branch, commit, and open the PR.

        STUB (the existing Cat 23 surface): returns the
        Gate-4a-blocked envelope when no ``req`` is provided.
        The two-stage opt-in (``code_change_enabled`` +
        ``auto_pr_enabled``) is checked FIRST so the auto-mode
        flow is never reachable without the explicit
        per-tenant opt-in.

        When a ``PRCreateRequest`` is passed (the
        agent-suggest flow), the call delegates to the
        :class:`PRProvider` directly and returns the
        :class:`PullRequestInfo`. The opt-in check is
        skipped on this path because the agent-suggest
        flow is human-in-the-loop (the "open PR" button
        click IS the opt-in).
        """
        if req is None:
            optin = _check_two_stage_optin(
                self.name, policy, "open_pr",
            )
            if optin is not None:
                return optin
            return _not_implemented_envelope(
                self.name,
                message=(
                    "PR creation requires Gate 4a (manual "
                    "end-to-end). The user-triggered 'Propose "
                    "code fix' + 'Open PR' flow opens a real "
                    "PR against a test repo once Gate 4a "
                    "ships."
                ),
                gate="4a_blocked",
                data={
                    "patch_id": patch_id,
                    "pr_id": _new_id("pr"),
                    "stub_id": _new_id("prcreator_stub"),
                },
            )
        try:
            info = await self._provider.create_pr(req)
        except NotImplementedError as exc:
            return _not_implemented_envelope(
                self.name,
                message=(
                    f"PR provider not configured: {exc}"
                ),
                gate="provider_not_implemented",
                data={
                    "patch_id": patch_id,
                    "provider": self._provider.name,
                },
            )
        return {
            "status": "ok",
            "feature": self.name,
            "live": True,
            "trace_id": _new_id("live"),
            "timestamp": None,
            "data": {
                "patch_id": patch_id,
                "pr": {
                    "number": info.number,
                    "title": info.title,
                    "branch": info.branch,
                    "base": info.base,
                    "url": info.url,
                    "state": info.state,
                    "created_at": info.created_at.isoformat(),
                },
            },
        }

    @property
    def provider_name(self) -> str:
        """The provider name (``"local"``, ``"github"``)."""
        return self._provider.name
