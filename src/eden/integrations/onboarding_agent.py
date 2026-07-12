"""LLM-assisted onboarding integration agent.

Deterministic heuristics (:mod:`framework_detector`) provide a fast,
reliable baseline. When the repo is ambiguous (low confidence, ``custom``,
or conflicting signals), this agent uses the T3 tier model to refine
framework/language detection and add integration notes.

Design priorities (in order):
  1. Bug-free — never apply invalid LLM output; always fall back to heuristics.
  2. Optimised — prefer minimal, idempotent file changes from the integrator.
  3. Best-effort — use agent reasoning when it can improve over heuristics.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import TYPE_CHECKING, Any

from eden.integrations.framework_detector import (
    FrameworkDetection,
    detect_framework_from_files,
)
from eden.integrations.sdk_integrator import IntegrationPlan, build_integration_plan_from_files
from eden.optimization.model_router import TIER_MODELS, ModelTier

if TYPE_CHECKING:
    from eden.providers.repo import GitHubRepoProvider

logger = logging.getLogger(__name__)

MANIFEST_PATHS = (
    "requirements.txt",
    "pyproject.toml",
    "package.json",
    "setup.py",
    "tsconfig.json",
    ".eden/config.yaml",
)

_SOURCE_SUFFIXES = (".py", ".ts", ".tsx", ".js", ".jsx")
_MAX_SOURCE_FILES = 12
_MAX_SOURCE_BYTES = 12_000

from eden.integrations.framework_registry import KNOWN_FRAMEWORK_IDS as _VALID_FRAMEWORKS
_VALID_LANGUAGES = frozenset({"python", "typescript", "unknown"})

_SYSTEM_PROMPT = """\
You are Eden's onboarding integration agent. Given repository manifests
and source snippets, refine how Eden should wire its observability SDK.

Rules:
- Pick framework from: langchain, crewai, autogen, llama_index, openai,
  anthropic, ollama, or custom when none match.
- Prefer the framework that best matches actual imports in source code.
- language: python | typescript | unknown
- confidence: 0.0-1.0 — be conservative; use <0.6 when unsure.
- entry_points: repo-relative paths to main/agent entry files (max 3).
- integration_notes: short bullets for the PR (minimal, safe wiring only).
- Never suggest deleting user code or modifying unrelated files.
- When uncertain, return framework=custom with low confidence.

Respond with ONLY valid JSON:
{"framework":"...","language":"...","confidence":0.0,"entry_points":[],"integration_notes":[],"rationale":"..."}
"""


async def fetch_integration_file_map(
    repo_provider: GitHubRepoProvider,
) -> dict[str, str]:
    """Fetch manifests + a small source sample for detection and the agent."""
    files: dict[str, str] = {}
    for path in MANIFEST_PATHS:
        content = await repo_provider.read_file(path)
        if content:
            files[path] = content

    try:
        tree = await repo_provider.list_files()
    except Exception as exc:
        logger.debug("onboarding_agent list_files failed: %s", exc)
        tree = []

    source_paths = [
        entry.path
        for entry in tree
        if entry.path.endswith(_SOURCE_SUFFIXES)
        and not entry.path.startswith(("node_modules/", "dist/", ".venv/", "vendor/"))
    ][: _MAX_SOURCE_FILES * 2]

    for path in source_paths:
        if len(files) >= len(MANIFEST_PATHS) + _MAX_SOURCE_FILES:
            break
        if path in files:
            continue
        content = await repo_provider.read_file(path)
        if content and len(content) <= _MAX_SOURCE_BYTES:
            files[path] = content

    return files


def _parse_agent_json(raw: str) -> dict[str, Any] | None:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _clamp_confidence(value: Any) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def _merge_detection(
    heuristic: FrameworkDetection,
    agent: dict[str, Any],
) -> FrameworkDetection:
    """Apply validated agent output; keep heuristic when agent is weak."""
    fw = str(agent.get("framework", "")).strip().lower()
    lang = str(agent.get("language", "")).strip().lower()
    agent_conf = _clamp_confidence(agent.get("confidence"))

    if fw not in _VALID_FRAMEWORKS:
        return heuristic
    if lang not in _VALID_LANGUAGES:
        lang = heuristic.language

    entry_points = agent.get("entry_points")
    if not isinstance(entry_points, list):
        entry_points = heuristic.entry_points
    else:
        entry_points = [
            str(p).strip()
            for p in entry_points[:3]
            if isinstance(p, str) and p.strip()
        ]

    # Agent must beat heuristics or resolve ambiguity.
    use_agent = (
        heuristic.framework == "custom"
        or heuristic.confidence < 0.85
        or agent_conf > heuristic.confidence + 0.05
    )
    if not use_agent or agent_conf < 0.55:
        return heuristic

    markers = list(heuristic.matched_markers)
    markers.append(f"agent:{fw}@{agent_conf:.2f}")
    rationale = agent.get("rationale")
    if isinstance(rationale, str) and rationale.strip():
        markers.append(f"agent_rationale:{rationale.strip()[:120]}")

    return FrameworkDetection(
        framework=fw,
        language=lang,
        confidence=max(heuristic.confidence, agent_conf),
        entry_points=entry_points or heuristic.entry_points,
        matched_markers=markers,
        existing_instrumentation=heuristic.existing_instrumentation,
        project_files=heuristic.project_files,
    )


async def refine_framework_detection(
    files: dict[str, str],
    heuristic: FrameworkDetection,
    *,
    org_id: str | None = None,
) -> tuple[FrameworkDetection, list[str]]:
    """Augment heuristic detection with T3 agent reasoning when useful."""
    if os.environ.get("EDEN_ONBOARDING_SKIP_LLM") == "1":
        return heuristic, []

    # High-confidence known frameworks: heuristics are enough.
    if (
        heuristic.framework != "custom"
        and heuristic.confidence >= 0.9
    ):
        return heuristic, []

    try:
        from eden.llm.client import OpenRouterClient

        llm = OpenRouterClient()
        model = TIER_MODELS[ModelTier.T3][0]
        manifest_blob = "\n\n".join(
            f"### {path}\n{content[:4000]}"
            for path, content in sorted(files.items())
        )
        prompt = (
            f"Heuristic detection: framework={heuristic.framework}, "
            f"language={heuristic.language}, confidence={heuristic.confidence:.2f}, "
            f"markers={heuristic.matched_markers}\n\n"
            f"Repository files:\n{manifest_blob[:24000]}"
        )
        response = await llm.acall(
            agent="onboarding_integration",
            prompt=prompt,
            system_prompt=_SYSTEM_PROMPT,
            model=model,
            slot="reasoning",
            max_tokens=512,
            org_id=org_id,
        )
        payload = _parse_agent_json(response.content)
        if not payload:
            return heuristic, []

        notes_raw = payload.get("integration_notes", [])
        notes = [
            str(n).strip()
            for n in notes_raw
            if isinstance(n, str) and n.strip()
        ][:5]

        merged = _merge_detection(heuristic, payload)
        return merged, notes
    except Exception as exc:
        logger.info("onboarding_integration agent skipped: %s", exc)
        return heuristic, []


def _apply_safety_notes(
    plan: IntegrationPlan,
    extra_notes: list[str],
) -> IntegrationPlan:
    """Append agent notes; integrator output stays minimal by design."""
    for note in extra_notes:
        if note not in plan.notes:
            plan.notes.append(note)
    if not any("idempotent" in n.lower() for n in plan.notes):
        plan.notes.append(
            "Integration prioritises minimal, idempotent changes. "
            "Merge, set EDEN_API_KEY + EDEN_DEFAULT_ORG, then verify traces in /traces."
        )
    return plan


async def build_integration_for_repo(
    repo_provider: GitHubRepoProvider,
    *,
    org_id: str | None = None,
) -> tuple[FrameworkDetection, IntegrationPlan]:
    """End-to-end: fetch files → detect → agent refine → safe plan."""
    files = await fetch_integration_file_map(repo_provider)
    heuristic = detect_framework_from_files(files)
    detection, agent_notes = await refine_framework_detection(
        files, heuristic, org_id=org_id,
    )
    plan = build_integration_plan_from_files(files, detection)
    plan = _apply_safety_notes(plan, agent_notes)
    return detection, plan


__all__ = [
    "MANIFEST_PATHS",
    "build_integration_for_repo",
    "fetch_integration_file_map",
    "refine_framework_detection",
]
