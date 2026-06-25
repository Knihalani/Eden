"""Framework detection for the onboarding wizard.

Walks a target repo and reports which agent framework is in use, plus
the entry points and existing instrumentation. The output drives the
SDK integrator and the PR that the onboarding flow opens against the
user's repo.

Detection strategy is import-pattern based: we look at
``requirements.txt`` / ``pyproject.toml`` / ``package.json`` for
declared deps and at the first 200 Python / TS files for canonical
imports (``from langchain.*``, ``import openai``, ``from anthropic``,
etc.). Heuristics are conservative — we never claim "custom" until
we have looked at a meaningful sample of files.

Originally lived under ``cli/eden/framework_detector.py`` while the
agent CLI shipped. The CLI was retired in the June 2026 cleanup; this
module is now imported by ``eden.api.routes.github`` (onboarding flow)
and the eval harness generator.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Canonical markers per framework. We use a (module, import_pattern)
# pair; either side matching counts.
FRAMEWORK_MARKERS: dict[str, dict[str, Any]] = {
    "langchain": {
        "pip": ["langchain", "langchain-core", "langchain-community"],
        "npm": ["langchain", "@langchain/core"],
        "imports": [
            r"from\s+langchain[\w\.]*\s+import",
            r"import\s+langchain[\w\.]*",
        ],
        "instrumentation": "LangChainInstrumentor",
    },
    "crewai": {
        "pip": ["crewai"],
        "npm": ["crewai"],
        "imports": [
            r"from\s+crewai\s+import",
            r"import\s+crewai",
        ],
        "instrumentation": "CrewAIInstrumentor",
    },
    "autogen": {
        "pip": ["pyautogen", "autogen-agentchat"],
        "npm": ["autogen"],
        "imports": [
            r"from\s+autogen\s+import",
            r"import\s+autogen",
            r"from\s+autogen_agentchat\s+import",
        ],
        "instrumentation": "AutoGenInstrumentor",
    },
    "llama_index": {
        "pip": ["llama-index", "llama_index"],
        "npm": ["llama-index", "@llamaindex/core"],
        "imports": [
            r"from\s+llama_index[\w\.]*\s+import",
            r"import\s+llama_index[\w\.]*",
            r"from\s+llama_index\.core\s+import",
        ],
        "instrumentation": "LlamaIndexInstrumentor",
    },
    "openai": {
        "pip": ["openai"],
        "npm": ["openai"],
        "imports": [
            r"from\s+openai\s+import",
            r"import\s+openai",
            r"OpenAI\s*\(",
        ],
        "instrumentation": "OpenAIInstrumentor",
    },
    "anthropic": {
        "pip": ["anthropic"],
        "npm": ["@anthropic-ai/sdk", "anthropic"],
        "imports": [
            r"from\s+anthropic\s+import",
            r"import\s+anthropic",
            r"Anthropic\s*\(",
        ],
        "instrumentation": "AnthropicInstrumentor",
    },
    # Ollama is its own provider *and* the most common way to run local
    # models. It also exposes an OpenAI-compatible endpoint at
    # ``<host>/v1/chat/completions``, so the OpenAI instrumentor catches
    # it too — but we still want a first-class ``ollama`` framework so
    # the SDK integrator writes the right bootstrap (sets
    # ``OPENAI_BASE_URL`` to ``http://localhost:11434/v1`` etc.) and
    # the dashboard attributes the trace to ``provider=ollama``.
    "ollama": {
        "pip": ["ollama"],
        "npm": ["ollama", "@ollama/ollama"],
        "imports": [
            r"from\s+ollama\s+import",
            r"import\s+ollama",
            r"Ollama\s*\(",
            r"ollama\.chat\s*\(",
        ],
        "instrumentation": "OpenAIInstrumentor",  # Ollama's OpenAI-compat path
    },
}


@dataclass
class FrameworkDetection:
    """Result of framework detection on a target repo."""

    framework: str  # e.g. "langchain", "openai", "custom"
    language: str  # "python" | "typescript" | "unknown"
    confidence: float  # 0.0 - 1.0
    entry_points: list[str] = field(default_factory=list)
    matched_markers: list[str] = field(default_factory=list)
    existing_instrumentation: list[str] = field(default_factory=list)
    project_files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "framework": self.framework,
            "language": self.language,
            "confidence": round(self.confidence, 3),
            "entry_points": self.entry_points,
            "matched_markers": self.matched_markers,
            "existing_instrumentation": self.existing_instrumentation,
            "project_files": self.project_files,
        }


def _safe_read_text(path: Path, max_bytes: int = 200_000) -> str:
    try:
        data = path.read_bytes()[:max_bytes]
        return data.decode("utf-8", errors="replace")
    except OSError:
        return ""


def _detect_language(root: Path) -> str:
    """Heuristic: presence of pyproject/requirements -> python; package.json -> ts/js."""
    has_py = any((root / name).exists() for name in ("pyproject.toml", "requirements.txt", "setup.py"))
    has_ts = any((root / name).exists() for name in ("package.json", "tsconfig.json"))
    if has_py and not has_ts:
        return "python"
    if has_ts and not has_py:
        return "typescript"
    if has_py and has_ts:
        return "python"  # prefer python default for LLM agents
    return "unknown"


def _iter_source_files(root: Path, language: str, limit: int = 200) -> list[Path]:
    if language == "python":
        exts = (".py",)
    elif language == "typescript":
        exts = (".ts", ".tsx", ".js", ".jsx")
    else:
        exts = (".py", ".ts", ".tsx", ".js", ".jsx")

    skip_dirs = {
        "node_modules", ".git", "venv", ".venv", "__pycache__",
        "dist", "build", ".next", ".turbo", "target",
    }
    found: list[Path] = []
    for path in root.rglob("*"):
        if path.is_dir():
            continue
        if any(part in skip_dirs for part in path.parts):
            continue
        if path.suffix.lower() in exts:
            found.append(path)
            if len(found) >= limit:
                break
    return found


def _parse_requirements_txt(text: str) -> list[str]:
    """Return a list of normalised package names from requirements.txt."""
    pkgs = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        # split on ==, >=, <=, ~=, [, ; whitespace
        name = re.split(r"[\[<>=!~;\s]", line, maxsplit=1)[0]
        name = name.strip().lower()
        if name:
            pkgs.append(name)
    return pkgs


def _parse_package_json_deps(text: str) -> list[str]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    deps = []
    for section in ("dependencies", "devDependencies", "peerDependencies"):
        deps.extend(data.get(section, {}).keys())
    return [d.lower() for d in deps]


def _parse_pyproject_deps(text: str) -> list[str]:
    """Best-effort: pull out a flat list of strings from project.dependencies."""
    # Heuristic regex; avoids requiring tomli/tomllib for fast detection.
    pkgs: list[str] = []
    # Look for `dependencies = [ ... ]` blocks
    for m in re.finditer(r"dependencies\s*=\s*\[([^\]]+)\]", text):
        block = m.group(1)
        for line in block.split(","):
            line = line.strip().strip("'\"")
            name = re.split(r"[\[<>=!~;\s]", line, maxsplit=1)[0].strip().lower()
            if name and not name.startswith("#"):
                pkgs.append(name)
    return pkgs


def _find_entry_points(root: Path, source_files: Iterable[Path]) -> list[str]:
    """Heuristic entry points: files with `if __name__ == "__main__"` or
    main functions in TypeScript. Paths are returned relative to
    ``root`` so callers can present them as repo-relative entries."""
    entries: list[str] = []
    for p in source_files:
        try:
            text = _safe_read_text(p, max_bytes=50_000)
        except OSError:
            continue
        if not text:
            continue
        try:
            rel = str(p.relative_to(root))
        except ValueError:
            rel = str(p)
        if re.search(r'__name__\s*==\s*[\'"]__main__[\'"]', text):
            entries.append(rel)
            continue
        if re.search(r"function\s+main\s*\(", text) or re.search(
            r"export\s+default\s+function", text
        ):
            entries.append(rel)
    return entries[:10]


def _detect_existing_instrumentation(source_files: Iterable[Path]) -> list[str]:
    """Look for any pre-existing observability wiring the user has."""
    found: list[str] = []
    patterns = {
        "opentelemetry": r"opentelemetry",
        "otel-instrumentation": r"OTLPSpanExporter|Instrumentation",
        "sentry": r"sentry_sdk|sentry\.",
        "logfire": r"logfire",
        "langsmith": r"langsmith",
        "langfuse": r"langfuse",
    }
    for p in source_files:
        text = _safe_read_text(p, max_bytes=100_000)
        for label, pat in patterns.items():
            if re.search(pat, text, re.IGNORECASE):
                found.append(label)
    # Dedupe, preserve order
    seen: dict[str, None] = {}
    for f in found:
        seen.setdefault(f, None)
    return list(seen.keys())


def _detect_ollama_env() -> str | None:
    """Return which env signal indicates Ollama, or ``None``.

    Detection order:
      1. ``OLLAMA_HOST`` set (non-empty).
      2. ``OPENAI_BASE_URL`` pointing at the Ollama default
         ``http://localhost:11434`` / ``127.0.0.1:11434`` (with or
         without ``/v1`` suffix).
    """
    import os
    if os.environ.get("OLLAMA_HOST"):
        return "OLLAMA_HOST"
    base = (os.environ.get("OPENAI_BASE_URL") or "").lower().rstrip("/")
    # Strip optional ``/v1`` and optional trailing path so e.g.
    # ``http://localhost:11434/v1`` matches ``http://localhost:11434``.
    for suffix in ("/v1",):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    if base in ("http://localhost:11434", "http://127.0.0.1:11434"):
        return "OPENAI_BASE_URL"
    return None


def _score_framework(
    framework: str,
    declared_deps: list[str],
    source_text: str,
    language: str,
) -> tuple[float, list[str]]:
    """Return (confidence 0..1, list of matched marker descriptions)."""
    meta = FRAMEWORK_MARKERS[framework]
    pip_markers = [d.lower() for d in meta["pip"]]
    npm_markers = [d.lower() for d in meta["npm"]]
    import_patterns = meta["imports"]

    matched: list[str] = []

    dep_hits = [
        d for d in declared_deps
        if any(d.startswith(m) or d == m for m in (pip_markers + npm_markers))
    ]
    if dep_hits:
        matched.extend(f"dep:{d}" for d in dep_hits)

    import_hits = []
    for pat in import_patterns:
        if re.search(pat, source_text, re.MULTILINE):
            import_hits.append(pat)
    if import_hits:
        matched.append(f"imports:{len(import_hits)}")

    # Confidence model:
    #  - dep hit alone -> 0.7
    #  - import hit alone -> 0.6
    #  - both -> 0.95
    #  - neither -> 0.0
    if dep_hits and import_hits:
        return 0.95, matched
    if dep_hits:
        return 0.7, matched
    if import_hits:
        return 0.6, matched
    return 0.0, []


def detect_framework(target: str | Path) -> FrameworkDetection:
    """Detect the agent framework in use at ``target``.

    Args:
        target: Path to the project root to analyze.

    Returns:
        A ``FrameworkDetection`` describing what was found. Always
        returns *something* — at worst the result is
        ``framework="custom"`` with ``confidence=0.0`` so callers can
        gracefully fall back to a generic integration path.
    """
    root = Path(target).expanduser().resolve()
    if not root.exists():
        return FrameworkDetection(
            framework="custom", language="unknown", confidence=0.0,
            entry_points=[], matched_markers=[], existing_instrumentation=[],
            project_files=[],
        )

    language = _detect_language(root)
    source_files = _iter_source_files(root, language)
    project_files_rel = [str(p.relative_to(root)) for p in source_files[:20]]

    declared_deps: list[str] = []
    req_path = root / "requirements.txt"
    if req_path.exists():
        declared_deps.extend(_parse_requirements_txt(_safe_read_text(req_path)))
    pp_path = root / "pyproject.toml"
    if pp_path.exists():
        declared_deps.extend(_parse_pyproject_deps(_safe_read_text(pp_path)))
    pj_path = root / "package.json"
    if pj_path.exists():
        declared_deps.extend(_parse_package_json_deps(_safe_read_text(pj_path)))

    # Concatenate source text (capped) for import scanning.
    source_text_parts: list[str] = []
    for p in source_files[:50]:
        source_text_parts.append(_safe_read_text(p, max_bytes=20_000))
    source_text = "\n".join(source_text_parts)

    # Score each candidate framework
    best_framework: str | None = None
    best_confidence = 0.0
    best_markers: list[str] = []

    for fw in FRAMEWORK_MARKERS:
        conf, markers = _score_framework(fw, declared_deps, source_text, language)
        if conf > best_confidence:
            best_confidence = conf
            best_framework = fw
            best_markers = markers

    # Env-var detection for Ollama. ``OLLAMA_HOST`` set, or
    # ``OPENAI_BASE_URL`` pointed at the Ollama OpenAI-compat endpoint,
    # is a 0.7-confidence signal — same weight as a pip dep hit, higher
    # than the openai/anthropic fallback below.
    ollama_env = _detect_ollama_env()
    if ollama_env and best_confidence < 0.7:
        best_framework = "ollama"
        best_confidence = max(best_confidence, 0.7)
        best_markers = [f"env:{ollama_env}"]

    if best_framework is None or best_confidence < 0.5:
        # Fall back: distinguish openai-direct vs anthropic-direct vs custom
        if any("openai" in d for d in declared_deps) or re.search(
            r"from\s+openai\s+import|import\s+openai|OpenAI\s*\(", source_text
        ):
            best_framework = "openai"
            best_confidence = max(best_confidence, 0.6)
            best_markers = ["fallback:openai"]
        elif any("anthropic" in d for d in declared_deps) or re.search(
            r"from\s+anthropic\s+import|import\s+anthropic|Anthropic\s*\(", source_text
        ):
            best_framework = "anthropic"
            best_confidence = max(best_confidence, 0.6)
            best_markers = ["fallback:anthropic"]

    if best_framework is None or best_confidence < 0.5:
        return FrameworkDetection(
            framework="custom",
            language=language,
            confidence=best_confidence,
            entry_points=_find_entry_points(root, source_files),
            matched_markers=best_markers,
            existing_instrumentation=_detect_existing_instrumentation(source_files),
            project_files=project_files_rel,
        )

    return FrameworkDetection(
        framework=best_framework,
        language=language,
        confidence=best_confidence,
        entry_points=_find_entry_points(root, source_files),
        matched_markers=best_markers,
        existing_instrumentation=_detect_existing_instrumentation(source_files),
        project_files=project_files_rel,
    )


def detect_framework_from_files(files: dict[str, str]) -> FrameworkDetection:
    """Same as :func:`detect_framework` but takes an in-memory file map
    instead of walking a real directory.

    The onboarding wizard calls this against files fetched via
    ``RepoProvider.read_file`` — no clone needed.

    Args:
        files: Mapping of repo-relative path -> file content. Caller
            should pre-filter to manifest files (requirements.txt,
            pyproject.toml, package.json) + a handful of source files.

    Returns:
        A ``FrameworkDetection``; falls back to ``custom`` if nothing
        meaningful is matched.
    """
    has_py = any(p in files for p in ("pyproject.toml", "requirements.txt", "setup.py"))
    has_ts = any(p in files for p in ("package.json", "tsconfig.json"))
    if has_py and not has_ts:
        language = "python"
    elif has_ts and not has_py:
        language = "typescript"
    elif has_py and has_ts:
        language = "python"
    else:
        language = "unknown"

    declared_deps: list[str] = []
    if "requirements.txt" in files:
        declared_deps.extend(_parse_requirements_txt(files["requirements.txt"]))
    if "pyproject.toml" in files:
        declared_deps.extend(_parse_pyproject_deps(files["pyproject.toml"]))
    if "package.json" in files:
        declared_deps.extend(_parse_package_json_deps(files["package.json"]))

    source_text = "\n".join(
        content for path, content in files.items()
        if path.endswith((".py", ".ts", ".tsx", ".js", ".jsx"))
    )

    best_framework: str | None = None
    best_confidence = 0.0
    best_markers: list[str] = []
    for fw in FRAMEWORK_MARKERS:
        conf, markers = _score_framework(fw, declared_deps, source_text, language)
        if conf > best_confidence:
            best_confidence = conf
            best_framework = fw
            best_markers = markers

    if best_framework is None or best_confidence < 0.5:
        if any("openai" in d for d in declared_deps):
            best_framework, best_confidence = "openai", 0.6
            best_markers = ["fallback:openai"]
        elif any("anthropic" in d for d in declared_deps):
            best_framework, best_confidence = "anthropic", 0.6
            best_markers = ["fallback:anthropic"]
        else:
            best_framework = "custom"

    return FrameworkDetection(
        framework=best_framework or "custom",
        language=language,
        confidence=best_confidence,
        entry_points=[],
        matched_markers=best_markers,
        existing_instrumentation=[],
        project_files=list(files.keys())[:20],
    )


__all__ = [
    "FRAMEWORK_MARKERS",
    "FrameworkDetection",
    "detect_framework",
    "detect_framework_from_files",
]
