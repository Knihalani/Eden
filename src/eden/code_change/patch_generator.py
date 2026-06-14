"""PatchGenerator — generate a unified diff for a Cat 2 RCA.

Uses the **v1.4 SLM (Qwen 3.5 4B)** for code understanding AND a
larger model (Claude Sonnet 4.6 default, configurable per-tenant)
for patch generation. The two-stage model split keeps cost low
(the SLM does the cheap read-the-code step) while preserving
quality (the larger model does the expensive write-the-patch
step).

Input: the linked source code (1-3 files), the Cat 2 RCA, the
failing trace, the desired test plan, and 2-3 in-context examples
from the :class:`CodebaseKnowledgeGraph` (the last successful
patch in this repo, in the same file, if any).

Output: a unified diff + a 1-paragraph description + a test plan
+ a blast-radius estimate. Validation: the diff must parse
(tree-sitter on the new file content), the patch must apply
cleanly to the base branch (the :class:`RepoConnector` clones to
a temp dir and tries ``git apply``), and the description must
mention the ``trace_id`` (a sanity check that the LLM didn't
hallucinate an unrelated patch). Persists to ``proposed_patches``
with ``status="proposed"``. Capped at
``max_cost_per_patch_usd`` per the policy.

STUB mode (Gate 4a — manual end-to-end) returns the
not-implemented envelope. The :class:`CodeChangeHook` calls
into this service from the Cat 2 RCA scorer; the stub-mode
return is a no-op log entry.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _new_id, _not_implemented_envelope

logger = logging.getLogger(__name__)


class PatchGenerator:
    """Generate a unified diff + test plan + blast-radius estimate."""

    name = "patch_generator"

    async def generate(
        self,
        org_id: str,
        rca_id: str,
        trace_id: str,
        repo_id: str,
    ) -> dict[str, Any]:
        """Run the two-stage SLM → larger-LLM generation. STUB: Gate 4a blocked."""
        return _not_implemented_envelope(
            self.name,
            message=(
                "Patch generation requires the v1.4 SLM (Qwen 3.5 4B) "
                "for the read-the-code step + the larger model "
                "(Claude Sonnet 4.6 default) for the write-the-patch "
                "step. Both ship in Gate 4a. STUB returns a blocked "
                "envelope so the Cat 2 RCA scorer can call into the "
                "generator without crashing."
            ),
            gate="4a_blocked",
            data={
                "patch_id": _new_id("patch"),
                "rca_id": rca_id,
                "trace_id": trace_id,
                "repo_id": repo_id,
                "stub_id": _new_id("patchgen_stub"),
            },
        )
