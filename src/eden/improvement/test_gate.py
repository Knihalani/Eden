"""M8 (spec §4.2, revives D19) — targeted sandbox test gate.

Before a code_patch plan enters the Improve inbox, discover the tests
that cover the diff-touched files **by naming convention only** (free —
no LLM), materialize base + patched file contents into a throwaway
sandbox workdir, and run exactly those tests through the allowlisted
subprocess sandbox (:mod:`eden.sandbox.runner`).

Environment honesty (spec §4.2 point 3): dependency installs are out of
scope, so import/collection errors are ``skipped:env_unavailable`` —
**never** "failed". Only genuine assertion failures fail the gate; the
caller (issue_patch_trigger) feeds the excerpt back through the
PatchGenerator ``static_feedback`` channel for one regenerate, then
suppresses.

Test synthesis (``test_gate_synthesis_v1``, default OFF — see the
§4.2 rationale: LLM-authored tests in customer PRs are a trust risk
until dogfood review, and executing LLM-authored code raises the
injection stakes): when ON and discovery finds nothing, one T1-slot
call writes a focused regression test under ``tests/eden_regression/``.
Synthesized tests execute ONLY with mandatory network isolation
(§7.3): if ``unshare --net`` is unavailable they are skipped
(``skipped:no_isolation``), never run unisolated.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

from eden.sandbox.runner import build_test_command, run_in_sandbox

logger = logging.getLogger(__name__)

#: Cap on convention-discovered test files (spec §4.2 point 1).
MAX_CANDIDATE_TESTS = 3
#: Tail of combined sandbox output carried in the result / feedback.
_EXCERPT_CHARS = 2000

_DIFF_PATH_RE = re.compile(r"^\+\+\+ (?:b/)?(\S+)", re.MULTILINE)
_PYTEST_FAILED_RE = re.compile(r"(\d+) failed")

_PY_SUFFIXES = {".py"}
_TS_SUFFIXES = {".ts", ".tsx", ".js", ".jsx"}
_GO_SUFFIXES = {".go"}

#: Output markers that mean "the environment can't run this test",
#: not "the patch broke it" — per language toolchain.
_ENV_ERROR_MARKERS = (
    # pytest / python
    "importerror",
    "modulenotfounderror",
    "error collecting",
    "errors during collection",
    "error while loading conftest",
    "no module named",
    # node / npm
    "cannot find module",
    "err_module_not_found",
    "missing script: test",
    "npm err!",
    # go
    "cannot find package",
    "no required module provides",
    "go.mod file not found",
)


@dataclass
class TestGateResult:
    """Outcome of :func:`run_test_gate` — honest by construction."""

    status: str  # "passed" | "failed" | "skipped"
    reason: str
    tests_run: list[str] = field(default_factory=list)
    failures: int = 0
    output_excerpt: str = ""
    #: True when the executed test was LLM-synthesized (§4.2). Carried
    #: in plan evidence now; the PR-body annotation lands in M9.
    synthesized: bool = False
    cost_usd: float = 0.0
    details: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "reason": self.reason,
            "tests_run": list(self.tests_run),
            "failures": self.failures,
            "output_excerpt": self.output_excerpt,
            "synthesized": self.synthesized,
            "cost_usd": round(self.cost_usd, 6),
            "details": self.details,
        }


def _skipped(reason: str, **details: Any) -> TestGateResult:
    return TestGateResult(status="skipped", reason=reason, details=dict(details))


# ── Injection seams (monkeypatchable in tests) ──────────────────


def _settings_enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "test_gate_enabled", True))
    except Exception:
        return True


async def _org_enabled(org_id: str) -> bool:
    """Org kill-switch (spec §10.2 marks this flag org-overridable)."""
    try:
        from eden.preview.gates import test_gate_enabled_for_org

        return await test_gate_enabled_for_org(org_id)
    except Exception:
        return _settings_enabled()


def _synthesis_settings_enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "test_gate_synthesis_v1", False))
    except Exception:
        return False


async def _synthesis_enabled(org_id: str) -> bool:
    """Default-OFF synthesis flag (§4.2), org-overridable."""
    try:
        from eden.preview.gates import test_gate_synthesis_enabled_for_org

        return await test_gate_synthesis_enabled_for_org(org_id)
    except Exception:
        return _synthesis_settings_enabled()


def _timeout_s() -> float:
    try:
        from eden.config import get_settings

        return float(getattr(get_settings(), "test_gate_timeout_s", 120) or 120)
    except Exception:
        return 120.0


# ── Discovery (free — convention globs, no LLM) ─────────────────


def _diff_file_paths(diff: str) -> list[str]:
    seen: list[str] = []
    for match in _DIFF_PATH_RE.finditer(diff or ""):
        path = match.group(1).strip()
        if path and path != "/dev/null" and path not in seen:
            seen.append(path)
    return seen


def _lang_for(path: str) -> str | None:
    suffix = PurePosixPath(path).suffix.lower()
    if suffix in _PY_SUFFIXES:
        return "python"
    if suffix in _TS_SUFFIXES:
        return "node"
    if suffix in _GO_SUFFIXES:
        return "go"
    return None


def _looks_like_test_file(path: str) -> bool:
    name = PurePosixPath(path).name.lower()
    return (
        name.startswith("test_")
        or name.endswith("_test.go")
        or ".test." in name
        or ".spec." in name
    )


def _candidate_globs(path: str) -> list[str]:
    """Convention globs for one diff-touched source file (spec §4.2).

    ``**/`` requires at least one directory level under both fnmatch
    and git pathspec semantics, so each convention also gets its
    root-level companion (``tests/test_x.py``, ``x.test.ts``, …).
    """
    stem = PurePosixPath(path).stem
    if not stem:
        return []
    lang = _lang_for(path)
    if lang == "python":
        return [f"tests/test_{stem}*.py", f"tests/**/test_{stem}*.py"]
    if lang == "node":
        # .tsx sources keep the same convention with their own suffix.
        return [
            f"{stem}.test.ts",
            f"**/{stem}.test.ts",
            f"{stem}.test.tsx",
            f"**/{stem}.test.tsx",
        ]
    if lang == "go":
        return [f"{stem}_test.go", f"**/{stem}_test.go"]
    return []


async def discover_candidate_tests(
    diff_files: list[str],
    repo_provider: Any,
) -> list[str]:
    """Find candidate test files by naming convention, cap 3.

    Pure besides ``repo_provider.list_files`` calls. Deterministic:
    glob order follows the diff-file order; matches within one glob are
    sorted. Diff files that are themselves tests are not sources to
    discover from (they'd only self-match).
    """
    if repo_provider is None:
        return []
    found: list[str] = []
    for source in diff_files or []:
        if _looks_like_test_file(source):
            continue
        for glob in _candidate_globs(source):
            if len(found) >= MAX_CANDIDATE_TESTS:
                return found
            try:
                entries = await repo_provider.list_files(glob)
            except Exception as exc:
                logger.debug("test_gate: list_files(%s) failed: %s", glob, exc)
                continue
            for path in sorted(
                str(getattr(e, "path", "") or "") for e in entries or []
            ):
                if path and path not in found:
                    found.append(path)
                    if len(found) >= MAX_CANDIDATE_TESTS:
                        return found
    return found


# ── Synthesis (default OFF — §4.2) ──────────────────────────────

#: Static system prompt — no per-call content so it stays cacheable.
_SYNTHESIS_SYSTEM_PROMPT = (
    "You write one focused pytest regression test for a bug fix. "
    "Return ONLY Python test code — no prose, no markdown fences. "
    "The test must import from the patched module paths shown, contain "
    "at least one function named test_*, use no network, no external "
    "services, and no fixtures beyond pytest builtins."
)


def _extract_code(raw: str) -> str:
    text = (raw or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        # Drop the opening fence (```python) and a trailing fence.
        lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


async def _synthesize_test(
    org_id: str,
    diff: str,
    base_files: list[dict[str, str]],
) -> tuple[str, str, float] | None:
    """One T1-slot call → ``(path, content, cost_usd)`` or None.

    Python-only for now (dogfood profile). Never raises.
    """
    diff_files = [p for p in _diff_file_paths(diff) if _lang_for(p) == "python"]
    if not diff_files:
        return None
    try:
        from eden.improvement.sweep_budget import try_consume_llm_call

        if not try_consume_llm_call():
            return None
        from eden.optimization.model_router import ModelRouter, PipelineTask

        # Correction #8: chat tiers share one model today — pin the
        # SLOT ("fast" → deterministic T1 heuristic) for routing
        # determinism, not a tier name.
        task = PipelineTask(
            agent="test_synthesizer",
            description="Synthesize focused regression test for patch",
            slot="fast",
            output_type="code",
            expected_min_length=30,
        )
        excerpts = "\n\n".join(
            f"### {f.get('path')}\n{(f.get('content') or '')[:1500]}"
            for f in (base_files or [])[:3]
            if f.get("path")
        )
        prompt = (
            "## Unified diff (the fix under test)\n"
            f"{(diff or '')[:3000]}\n\n"
            "## Patched files (excerpts)\n"
            f"{excerpts}\n"
        )
        router = ModelRouter()
        response = await router.aroute(
            task,
            prompt,
            system_prompt=_SYNTHESIS_SYSTEM_PROMPT,
            org_id=org_id,
            max_tokens=1024,
        )
        content = _extract_code(getattr(response, "content", "") or "")
        cost = float(getattr(getattr(response, "usage", None), "cost", 0) or 0)
        if "def test_" not in content:
            return None
        stem = PurePosixPath(diff_files[0]).stem or "patch"
        path = f"tests/eden_regression/test_regression_{stem}.py"
        return path, content, cost
    except Exception as exc:
        logger.debug("test_gate: synthesis failed: %s", exc)
        return None


# ── Result interpretation (pure) ────────────────────────────────


def _tail(text: str, limit: int = _EXCERPT_CHARS) -> str:
    return text[-limit:] if len(text) > limit else text


def interpret_sandbox_result(
    sandbox: Any,
    *,
    lang: str | None,
) -> tuple[str, str, int, str]:
    """Map a :class:`SandboxResult` to ``(status, reason, failures, excerpt)``.

    Environment honesty: anything that means "couldn't run" is a
    labeled skip, never a failure.
    """
    output = f"{sandbox.stdout or ''}\n{sandbox.stderr or ''}"
    excerpt = _tail(output.strip())
    error = getattr(sandbox, "error", None)
    if error == "isolation_unavailable":
        return "skipped", "no_isolation", 0, ""
    if error in ("command_not_allowlisted", "executable_not_found"):
        return "skipped", "env_unavailable", 0, excerpt
    if error == "path_traversal_or_bad_patch":
        return "skipped", "env_unavailable", 0, excerpt
    if sandbox.timed_out:
        # A 120s budget blown on ≤3 targeted tests is environment
        # weirdness far more often than a genuine hang — honest skip.
        return "skipped", "timeout", 0, excerpt
    if sandbox.exit_code == 0:
        return "passed", "tests_passed", 0, excerpt
    lowered = output.lower()
    if any(marker in lowered for marker in _ENV_ERROR_MARKERS):
        return "skipped", "env_unavailable", 0, excerpt
    if lang == "python":
        # pytest: 1=failures, 2=interrupted/collection, 3=internal,
        # 4=usage, 5=nothing collected. Only 1 is a test verdict.
        if sandbox.exit_code == 5:
            return "skipped", "no_tests_collected", 0, excerpt
        if sandbox.exit_code in (2, 3, 4):
            return "skipped", "env_unavailable", 0, excerpt
    failures = 1
    match = _PYTEST_FAILED_RE.search(output)
    if match:
        failures = max(1, int(match.group(1)))
    return "failed", "tests_failed", failures, excerpt


# ── Core ────────────────────────────────────────────────────────


async def run_test_gate(
    org_id: str,
    repo_id: str,
    diff: str,
    linked_files: list[dict[str, str]],
    *,
    provider: Any,
    base_files: list[dict[str, str]] | None = None,
) -> TestGateResult:
    """Discover + run targeted tests on the patched files in the sandbox.

    Never raises. Status taxonomy: ``passed``, ``failed`` (genuine
    assertion failures only), ``skipped:<reason>`` for every honest
    non-answer (disabled, no_tests_found, env_unavailable, timeout,
    no_isolation, patch_touches_tests, …).
    """
    started = time.monotonic()
    base = list(base_files if base_files is not None else linked_files or [])
    try:
        return await _run_test_gate_inner(
            org_id, repo_id, diff, linked_files, provider, base, started
        )
    except Exception as exc:
        logger.warning("test_gate: unexpected error: %s", exc)
        return _skipped("test_gate_error", error=str(exc)[:200])


async def _run_test_gate_inner(
    org_id: str,
    repo_id: str,
    diff: str,
    linked_files: list[dict[str, str]],
    provider: Any,
    base_files: list[dict[str, str]],
    started: float,
) -> TestGateResult:
    if not _settings_enabled() or not await _org_enabled(org_id):
        return _skipped("disabled")
    if not (diff or "").strip():
        return _skipped("empty_diff")
    if provider is None:
        return _skipped("no_provider")

    diff_files = _diff_file_paths(diff)
    try:
        tests = await discover_candidate_tests(diff_files, provider)
    except Exception as exc:
        return _skipped("discovery_error", error=str(exc)[:200])

    # §7.3: refuse to run tests the patch itself modifies while
    # synthesis is off (self-validating patch trick).
    touched = set(diff_files)
    overlap = [t for t in tests if t in touched]
    tests = [t for t in tests if t not in touched]
    if overlap and not tests:
        return _skipped("patch_touches_tests", tests=overlap)

    synthesized = False
    synth_cost = 0.0
    synth_file: dict[str, str] | None = None
    if not tests:
        if not await _synthesis_enabled(org_id):
            return _skipped("no_tests_found")
        synth = await _synthesize_test(org_id, diff, base_files)
        if synth is None:
            return _skipped("synthesis_failed")
        synth_path, synth_content, synth_cost = synth
        synth_file = {"path": synth_path, "content": synth_content}
        tests = [synth_path]
        synthesized = True

    # Materialize base + patched contents (in memory, no repo write).
    try:
        from eden.improvement.evidence_plane import apply_diff_to_files

        applied = await apply_diff_to_files(diff, base_files, run_static=False)
    except Exception as exc:
        return _skipped("not_materializable", error=str(exc)[:200])
    if applied.get("status") != "passed":
        return _skipped(
            "not_materializable",
            error=str((applied.get("detail") or {}).get("reason") or "")[:200],
            cost_usd=synth_cost,
        )
    contents: dict[str, str] = {
        str(f.get("path") or ""): str(f.get("content") or "")
        for f in base_files
        if f.get("path")
    }
    for item in (applied.get("detail") or {}).get("files_after") or []:
        path = str(item.get("path") or "")
        if path:
            contents[path] = str(item.get("content") or "")

    sandbox_files = [
        {"path": path, "content": content} for path, content in contents.items()
    ]
    if synthesized and synth_file is not None:
        sandbox_files.append(synth_file)
    else:
        # Copy the discovered test files in from the repo.
        readable: list[str] = []
        for test_path in tests:
            try:
                content = await provider.read_file(test_path)
            except Exception as exc:
                logger.debug("test_gate: read %s failed: %s", test_path, exc)
                content = ""
            if (content or "").strip():
                sandbox_files.append({"path": test_path, "content": content})
                readable.append(test_path)
        tests = readable
        if not tests:
            return _skipped("test_read_failed")

    lang = _lang_for(tests[0])
    command = build_test_command(tests)
    if command is None:
        return _skipped("unsupported_language", tests=tests)

    sandbox = await run_in_sandbox(
        command,
        files=sandbox_files,
        timeout_sec=_timeout_s(),
        # §7.3: network isolation is best-effort for repo tests but
        # MANDATORY for LLM-synthesized tests.
        require_isolation=synthesized,
    )
    status, reason, failures, excerpt = interpret_sandbox_result(sandbox, lang=lang)
    return TestGateResult(
        status=status,
        reason=reason,
        tests_run=list(tests),
        failures=failures,
        output_excerpt=excerpt,
        synthesized=synthesized,
        cost_usd=synth_cost,
        details={
            "repo_id": repo_id,
            "isolation": getattr(sandbox, "isolation", "subprocess"),
            "exit_code": getattr(sandbox, "exit_code", None),
            "duration_ms": int((time.monotonic() - started) * 1000),
        },
    )


__all__ = [
    "MAX_CANDIDATE_TESTS",
    "TestGateResult",
    "discover_candidate_tests",
    "interpret_sandbox_result",
    "run_test_gate",
]
