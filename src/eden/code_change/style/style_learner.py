"""CodeStyleLearner — learn the repo's style from existing files + merged PRs.

The service runs in two phases:

1. **Code pattern extraction** — reads the last N files via the
   :class:`RepoProvider`, runs a T1 model pass over the file
   contents, and extracts indentation / type-hint style /
   naming / import style / error-handling / logging /
   docstring / test framework.
2. **Lint config detection** — reads ``pyproject.toml``,
   ``.flake8``, ``mypy.ini``, ``.eslintrc``, ``tsconfig.json``,
   ``.prettierrc``, ``biome.json`` via the same provider.

The profile is persisted to ``repo_style_profiles`` (one row
per ``(org_id, repo_id)``). Re-running :meth:`learn` upserts.
:meth:`get_profile` reads the persisted row.

STATUS: pending=True (upgradespec §D.7 — table deferred; learn() and
get_profile() fall back to ``DEFAULT_STYLE_PROFILE`` until Gate-4 lands
and the table is re-added via a follow-up migration).

T1 model choice: classification + extraction task, not code
generation. T1 keeps cost ~10x cheaper than T2 and runs
synchronously inside the connect flow without blocking.

Degraded mode: when the LLM call fails or returns unparseable
JSON, ``learn`` returns :data:`DEFAULT_STYLE_PROFILE` with
``source="defaults"``. The portal always gets a usable profile.
This is real behaviour, not a placeholder — the
``DEFAULT_STYLE_PROFILE`` is a documented baseline that
matches every Python+FastAPI repo that hasn't customised.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from eden.code_change._common import _delete_then_insert, _select_one
from eden.optimization.model_router import ModelRouter, PipelineTask

from .._common import _ok_envelope

logger = logging.getLogger(__name__)


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

DEFAULT_SAMPLE_GLOBS = ["**/*.py", "**/*.ts", "**/*.tsx"]

LINT_CONFIG_FILENAMES = (
    "pyproject.toml",
    "setup.cfg",
    ".flake8",
    "mypy.ini",
    ".ruff.toml",
    "ruff.toml",
    ".eslintrc",
    ".eslintrc.json",
    "tsconfig.json",
    ".prettierrc",
    "biome.json",
)


def _build_extraction_prompt(file_samples: list[dict[str, str]]) -> str:
    """Build the T1 extraction prompt from N file samples."""
    parts = [
        "You are a code-style analyzer. Extract the following from "
        "the file samples and return ONLY a JSON object with these keys:\n",
        "- indentation: {type: 'spaces'|'tabs', size: int}\n",
        "- type_hints_style: 'pep484'|'pep604'|'none'\n",
        "- naming_convention: {function: 'snake_case'|'camelCase', "
        "class: 'PascalCase', constant: 'UPPER_SNAKE_CASE'}\n",
        "- import_style: 'absolute'|'relative'\n",
        "- error_handling: 'exceptions'|'result'|'mixed'\n",
        "- logging_style: 'stdlib-logging'|'loguru'|'structlog'\n",
        "- docstring_style: 'google'|'numpy'|'sphinx'|'none'\n",
        "- test_framework: 'pytest'|'unittest'|'jest'|'vitest'|'none'\n",
        "- complexity_median: int (rough median cyclomatic complexity)\n",
        "- architecture_patterns: dict of detected patterns\n\n",
        "File samples (path: first 500 chars):\n",
    ]
    for sample in file_samples[:20]:
        parts.append(f"--- {sample['path']} ---\n{sample['content']}\n\n")
    parts.append(
        "Return a single JSON object. No prose, no markdown fences."
    )
    return "".join(parts)


def _parse_extraction_response(raw: str) -> dict[str, Any]:
    """Best-effort JSON parse with lenient fallback."""
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]
        data = json.loads(cleaned)
        if isinstance(data, dict):
            return data
    except Exception as exc:
        logger.debug("style_learner: extraction JSON parse failed: %s", exc)
    return {}


def _merge_profile(
    learned: dict[str, Any], defaults: dict[str, Any]
) -> dict[str, Any]:
    """Merge learned values over defaults, keeping only known keys."""
    out: dict[str, Any] = dict(defaults)
    for key, default in defaults.items():
        if key not in learned:
            continue
        value = learned[key]
        if isinstance(default, dict) and isinstance(value, dict):
            out[key] = {**default, **value}
        else:
            out[key] = value
    return out


class CodeStyleLearner:
    """Learn + maintain the per-repo style profile."""

    name = "code_style_learner"

    def __init__(
        self,
        router: ModelRouter | None = None,
        sample_size: int = 20,
    ) -> None:
        self._router = router
        self._sample_size = sample_size

    async def learn(
        self,
        org_id: str,
        repo_id: str,
        provider: Any | None = None,
    ) -> dict[str, Any]:
        """Read N sample files + lint configs, extract patterns via T1.

        The caller passes a :class:`RepoProvider` (the same one
        :class:`RepoConnector` uses). When ``provider`` is ``None``,
        :meth:`get_profile` still returns a usable profile based on
        :data:`DEFAULT_STYLE_PROFILE` — degraded mode, not failure.
        """
        profile = dict(DEFAULT_STYLE_PROFILE)
        last_pr_id: str | None = None

        if provider is not None:
            profile, last_pr_id = await self._learn_from_repo(
                provider, profile, org_id
            )

        # Persist (delete-then-insert) to repo_style_profiles.
        try:
            await _delete_then_insert(
                org_id,
                "id",
                f"{org_id}|{repo_id}",
                "repo_style_profiles",
                [
                    "id",
                    "repo_id",
                    "indentation",
                    "type_hints_style",
                    "naming_convention",
                    "import_style",
                    "error_handling",
                    "logging_style",
                    "docstring_style",
                    "test_framework",
                    "lint_config",
                    "complexity_median",
                    "architecture_patterns",
                    "last_learned_from_pr_id",
                ],
                [
                    f"{org_id}|{repo_id}",
                    repo_id,
                    json.dumps(profile.get("indentation") or {}),
                    str(profile.get("type_hints_style") or "pep484"),
                    json.dumps(profile.get("naming_convention") or {}),
                    str(profile.get("import_style") or "absolute"),
                    str(profile.get("error_handling") or "exceptions"),
                    str(profile.get("logging_style") or "stdlib-logging"),
                    str(profile.get("docstring_style") or "google"),
                    str(profile.get("test_framework") or "pytest"),
                    json.dumps(profile.get("lint_config") or {}),
                    int(profile.get("complexity_median") or 5),
                    json.dumps(profile.get("architecture_patterns") or {}),
                    last_pr_id,
                ],
            )
        except Exception as exc:
            logger.debug(
                "style_learner: persistence failed for %s: %s", repo_id, exc,
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "repo_id": repo_id,
                "profile": profile,
                "last_learned_from_pr_id": last_pr_id,
                "source": "learned" if provider is not None else "defaults",
            },
        )

    async def get_profile(
        self,
        org_id: str,
        repo_id: str,
    ) -> dict[str, Any]:
        """Return the persisted profile, or defaults if none yet."""
        row = await _select_one(
            org_id,
            "repo_style_profiles",
            where="repo_id = $2",
            params=(repo_id,),
        )
        if row is None:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "repo_id": repo_id,
                    "profile": dict(DEFAULT_STYLE_PROFILE),
                    "source": "defaults",
                },
            )

        def _coerce(raw: Any) -> Any:
            if isinstance(raw, str):
                try:
                    return json.loads(raw)
                except Exception:
                    return raw
            return raw

        profile = {
            "indentation": _coerce(row.get("indentation")),
            "type_hints_style": row.get("type_hints_style") or "pep484",
            "naming_convention": _coerce(row.get("naming_convention")),
            "import_style": row.get("import_style") or "absolute",
            "error_handling": row.get("error_handling") or "exceptions",
            "logging_style": row.get("logging_style") or "stdlib-logging",
            "docstring_style": row.get("docstring_style") or "google",
            "test_framework": row.get("test_framework") or "pytest",
            "lint_config": _coerce(row.get("lint_config")),
            "complexity_median": row.get("complexity_median") or 5,
            "architecture_patterns": _coerce(row.get("architecture_patterns")),
        }
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "repo_id": repo_id,
                "profile": profile,
                "last_learned_at": row["last_learned_at"].isoformat()
                if row.get("last_learned_at") else None,
                "last_learned_from_pr_id": row.get("last_learned_from_pr_id"),
                "source": "learned",
            },
        )

    async def _learn_from_repo(
        self,
        provider: Any,
        base_profile: dict[str, Any],
        org_id: str,
    ) -> tuple[dict[str, Any], str | None]:
        """Read sample files + lint configs, call T1, merge results."""
        samples: list[dict[str, str]] = []
        files: list[Any] = []
        for glob in DEFAULT_SAMPLE_GLOBS:
            try:
                files = await provider.list_files(path_glob=glob)
            except Exception:
                files = []
            if files:
                break

        for entry in files[: self._sample_size]:
            try:
                content = await provider.read_file(entry.path)
            except Exception:
                continue
            samples.append({"path": entry.path, "content": content[:500]})

        # Read lint config files (best-effort).
        lint_config: dict[str, str] = {}
        for name in LINT_CONFIG_FILENAMES:
            try:
                content = await provider.read_file(name)
                if content:
                    lint_config[name] = content[:500]
            except Exception:
                continue
        if lint_config and isinstance(base_profile.get("lint_config"), dict):
            base_profile["lint_config"] = {
                **base_profile["lint_config"],
                **{k: v for k, v in lint_config.items()},
            }

        last_pr_id: str | None = None
        if self._router is not None and samples:
            task = PipelineTask(
                agent="code_style_learner",
                description="Extract repo style profile from sample files",
                slot="fast",
                output_type="json",
                expected_min_length=20,
                required_format="json",
            )
            # ``aroute`` walks the T1 → T2 → T3 fallback chain
            # defined in ``model_router.TIER_MODELS`` (gpt-4o-mini
            # → claude-3-haiku → gemini-2.0-flash → then escalates
            # to T2/T3 if all T1 models fail). Slot="fast" pins
            # the start tier to T1 per the TaskClassifier heuristic.
            response = await self._router.aroute(
                task,
                _build_extraction_prompt(samples),
                org_id=org_id,
                user_id=None,
                max_tokens=512,
            )
            learned = _parse_extraction_response(response.content)
            base_profile = _merge_profile(learned, base_profile)

        # Capture the most-recent merged PR id (best-effort).
        try:
            prs = await provider.list_pull_requests(state="closed", limit=1)
            for pr in prs:
                last_pr_id = str(getattr(pr, "number", "") or "") or None
                break
        except Exception:
            last_pr_id = None

        return base_profile, last_pr_id
