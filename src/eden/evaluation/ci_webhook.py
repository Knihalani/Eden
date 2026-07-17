"""N01 CI webhook — run regression suite on prompt/config changes."""

from __future__ import annotations

import logging
from typing import Any

from eden.evaluation.regression_runner import RegressionRunner

logger = logging.getLogger(__name__)


class CIWebhookHandler:
    """Trigger regression eval when agent config files change."""

    async def on_prompt_change(
        self,
        org_id: str,
        *,
        changed_files: list[str],
        change_id: str,
        agent_id: str | None = None,
    ) -> dict[str, Any]:
        runner = RegressionRunner()
        result = await runner.run_suite(
            org_id, agent_id=agent_id, change_id=change_id
        )
        gate = "pass" if result.ok else "block"
        return {
            "change_id": change_id,
            "changed_files": changed_files,
            "regression": result.to_dict(),
            "gate": gate,
        }


__all__ = ["CIWebhookHandler"]
