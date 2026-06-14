"""CodeRootCauseLinker — map a Cat 2 RCA to source files.

Consumes Cat 2 RCA output + Cat 16 Decision paths + the
customer's source code (read via the :class:`RepoConnector`).
Builds a per-repo call graph using tree-sitter (already a
transitive dep via LangChain); maps trace events to source
files/functions via (a) stack-trace correlation (when present),
(b) request-path → controller file mapping (for HTTP), (c)
tool-call signature → tool registration lookup (Cat 7), and
(d) LLM inference ("given this RCA 'rate limiter retry_after
off by 1', which file/function most likely matches?").

Persists to ``code_root_cause_links`` with a confidence score.
The 4-source correlation is critical: stack-trace alone misses
60% of LLM-app failures (the LLM layer doesn't always emit a
stack trace); LLM inference alone hallucinates file paths. The
combination is the same pattern as Cat 5's MemoryAttributor
(multi-signal correlation with confidence adjustments).

STUB mode (Gate 2 — attribution accuracy) returns the
not-implemented envelope with a ``gate=2_blocked`` marker
because the tree-sitter call graph + the LLM-inference
correlator require the Gate-2 work to be complete.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from ._common import _new_id, _not_implemented_envelope

logger = logging.getLogger(__name__)


def _content_derived_id(*parts: str) -> str:
    """A deterministic ``crcl_<sha256[:16]>`` id so the same
    ``(org, rca_id, file_path)`` triple always maps to the same
    row — important for idempotent re-runs.
    """
    h = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    return f"crcl_{h}"


class CodeRootCauseLinker:
    """Map a Cat 2 RCA to source files / functions."""

    name = "code_root_cause_linker"

    async def link(
        self,
        org_id: str,
        rca_id: str,
        repo_id: str,
    ) -> dict[str, Any]:
        """Run the multi-signal attribution. STUB: not implemented (Gate 2)."""
        # Deterministic, content-derived id so tests can assert
        # the id shape without depending on the Gate-2 logic.
        link_id = _content_derived_id(org_id, rca_id, repo_id)
        return _not_implemented_envelope(
            self.name,
            message=(
                "4-source attribution (stack-trace + request-path + "
                "tool-call lookup + LLM inference) requires Gate 2 "
                "(attribution accuracy) to ship. STUB returns the "
                "deterministic link id so the Cat 2 RCA scorer can "
                "still call into the linker without crashing."
            ),
            gate="2_blocked",
            data={
                "link_id": link_id,
                "rca_id": rca_id,
                "repo_id": repo_id,
                "stub_id": _new_id("crcl_stub"),
            },
        )
