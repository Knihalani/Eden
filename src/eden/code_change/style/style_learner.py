"""CodeStyleLearner — learn the repo's style from the last 100 merged PRs.

On repo registration, the service:

1. **Reads the last 100 merged PRs** in the repo (via the GitHub
   API) and extracts the diff for each. From the diffs, it
   learns: indentation (tabs vs spaces, indent size), type-hint
   style, naming convention per symbol type, import style,
   error-handling style (exceptions vs ``Result``/Either),
   logging style, docstring style (Google/NumPy/Sphinx/none),
   and the test framework.
2. **Reads the repo's existing style config**:
   ``pyproject.toml``, ``setup.cfg``, ``.flake8``, ``mypy.ini``,
   ``.eslintrc``, ``tsconfig.json``, ``.prettierrc``,
   ``biome.json``, ``Cargo.toml``, ``go.mod``. Auto-detected by
   filename. Captures lint rules, type-check strictness,
   formatter choice.
3. **Detects architecture patterns**: dependency-injection,
   async-vs-sync, state management, error-propagation patterns,
   custom exception classes.
4. **Builds a ``repo_style_profile`` JSON** that captures all
   of the above. Persists to ``repo_style_profiles``.
5. **Updates continuously**: every time a PR is merged, the
   learner re-reads the diff and updates the profile. The
   agent learns from every human review — if a human editor
   adjusts the agent's patch before approving, the agent's
   next patch in the same file is closer to the human's
   preferred style.

The :class:`PRQualityScorer` is gated on
``repo_style_profile`` existing for the target repo; without
it, the agent refuses to propose a patch (the alternative is
shipping low-quality code that doesn't match the repo).

STUB mode (Gate 4a) returns the live envelope with a
deterministic default style profile. The real implementation
will read the 100 merged PRs + the style config files.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


# The canonical style-profile shape. The real Gate-4a
# implementation will populate these from the 100-merged-PR
# analysis. The stub returns the defaults so the
# ``PRQualityScorer`` + ``PatchGenerator`` can run end-to-end.
DEFAULT_STYLE_PROFILE: dict[str, Any] = {
    "indentation": {"type": "spaces", "size": 4},
    "type_hints_style": "pep484",
    "naming_convention": {
        "function": "snake_case",
        "class": "PascalCase",
        "constant": "UPPER_SNAKE_CASE",
    },
    "import_style": "absolute",
    "error_handling": "exceptions",
    "logging_style": "stdlib-logging",
    "docstring_style": "google",
    "test_framework": "pytest",
    "lint_config": {"ruff": "default", "mypy": "default"},
    "complexity_median": 5,
    "architecture_patterns": {"di": "fastapi-depends", "async": True},
}


class CodeStyleLearner:
    """Learn + maintain the per-repo style profile."""

    name = "code_style_learner"

    async def learn(
        self,
        org_id: str,
        repo_id: str,
    ) -> dict[str, Any]:
        """Read the 100 merged PRs + the style config, build the profile.

        STUB: returns the default profile. The real Gate-4a
        implementation will run the multi-source analysis
        described in the module docstring.
        """
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "repo_id": repo_id,
                "profile": dict(DEFAULT_STYLE_PROFILE),
                "profile_id": _new_id("style"),
                "last_learned_at": None,  # filled by the real impl
                "last_learned_from_pr_id": None,
                "message": (
                    "Stub learn — Gate 4a will read the last 100 "
                    "merged PRs + the repo's style config files."
                ),
            },
        )

    async def get_profile(
        self, org_id: str, repo_id: str
    ) -> dict[str, Any]:
        """Return the current style profile. STUB: returns the defaults."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "repo_id": repo_id,
                "profile": dict(DEFAULT_STYLE_PROFILE),
                "message": "Stub profile — defaults returned.",
            },
        )
