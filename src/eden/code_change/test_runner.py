"""TestPlanRunner — run the customer's CI + Eden's golden tests.

Two paths:

* **Generate the test plan** — uses a T1 model to derive
  3-5 targeted regression tests from the RCA + the diff.
  Returns the test plan as a JSON array. Always available.
* **Run the tests** — Gate 3 sandbox substitute via
  :mod:`eden.sandbox.runner`. When ``code_change_enabled``
  is true the runner creates a temp workdir, applies patch
  files (path-traversal rejected), and executes an
  allowlisted command (``pytest`` / ``npm test`` / ``go test``)
  under a wall-clock timeout. Full Firecracker isolation is
  a future enhancement; without the opt-in the method still
  returns the deterministic ``gate=3_blocked`` envelope.

Persists to ``patch_test_runs`` with the pass/fail counts.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from eden.optimization.model_router import ModelRouter, PipelineTask

from ._common import (
    DEFAULT_POLICY,
    _insert_row,
    _new_id,
    _not_implemented_envelope,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


SANDBOX_CPU_LIMIT = "2.0"
SANDBOX_MEMORY_MB = 4096
SANDBOX_WALL_CLOCK_SEC = 600

_PYTEST_PASSED = re.compile(r"(\d+)\s+passed")
_PYTEST_FAILED = re.compile(r"(\d+)\s+failed")


_TEST_PLAN_PROMPT = """\
You are writing the targeted regression test plan for a code
patch. Return ONLY a JSON array of test descriptions — one
sentence each, no prose, no markdown fences. Generate 3-5 tests
that cover the failure mode described in the RCA, the edge
cases in the diff, and the happy-path regression.

## RCA summary
{rca_summary}

## Diff (first 1000 chars)
{diff_first_1k}

Each test description should follow the format:
"test_<unit>_<scenario>_<expected_outcome>"
"""


def _parse_test_plan_response(raw: str) -> list[str]:
    """Parse the model's JSON-array response into a list of test names."""
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]
        data = json.loads(cleaned)
        if isinstance(data, list):
            return [str(x) for x in data]
    except Exception as exc:
        logger.debug("test_runner: test plan JSON parse failed: %s", exc)
    return []


async def _generate_test_plan(
    router: ModelRouter | None,
    rca_summary: str,
    diff: str,
) -> list[str]:
    """Generate the test plan via T1 (no sandbox needed)."""
    if router is None:
        return [
            f"test_{rca_summary[:20].strip().replace(' ', '_').lower()}_regression",
            "test_diff_happy_path",
            "test_diff_edge_case",
        ]
    task = PipelineTask(
        agent="tester",
        description="Generate the targeted regression test plan for a patch",
        slot="fast",
        output_type="json",
        expected_min_length=20,
        required_format="json",
    )
    try:
        response = await router.aroute(
            task,
            _TEST_PLAN_PROMPT.format(
                rca_summary=rca_summary or "(none)",
                diff_first_1k=(diff or "")[:1000],
            ),
            max_tokens=300,
        )
        plan = _parse_test_plan_response(response.content)
        if plan:
            return plan
    except Exception as exc:
        logger.debug("test_runner: LLM test plan failed: %s", exc)
    return [
        f"test_{rca_summary[:20].strip().replace(' ', '_').lower()}_regression",
        "test_diff_happy_path",
        "test_diff_edge_case",
    ]


def _parse_pytest_counts(stdout: str, stderr: str) -> tuple[int, int, int]:
    """Best-effort parse of pytest summary lines."""
    blob = f"{stdout}\n{stderr}"
    passed = 0
    failed = 0
    m_pass = _PYTEST_PASSED.search(blob)
    m_fail = _PYTEST_FAILED.search(blob)
    if m_pass:
        passed = int(m_pass.group(1))
    if m_fail:
        failed = int(m_fail.group(1))
    total = passed + failed
    return passed, failed, total


def _resolve_command(spec: Any | None) -> list[str]:
    """Derive the allowlisted argv from an optional ``spec``."""
    import sys

    if spec is None:
        return [sys.executable, "-m", "pytest", "-q"]
    if isinstance(spec, dict):
        cmd = spec.get("command") or spec.get("argv")
        if isinstance(cmd, (list, tuple)) and cmd:
            return [str(c) for c in cmd]
        framework = str(spec.get("framework") or "pytest").lower()
        if framework in {"npm", "node", "javascript"}:
            return ["npm", "test"]
        if framework in {"go", "golang"}:
            return ["go", "test", "./..."]
        return [sys.executable, "-m", "pytest", "-q"]
    # Duck-typed SandboxSpec-like object.
    cmd = getattr(spec, "command", None) or getattr(spec, "argv", None)
    if isinstance(cmd, (list, tuple)) and cmd:
        return [str(c) for c in cmd]
    return [sys.executable, "-m", "pytest", "-q"]


def _resolve_files(spec: Any | None, files: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if files:
        return list(files)
    if spec is None:
        return []
    if isinstance(spec, dict):
        raw = spec.get("files") or spec.get("patch_files") or []
        return list(raw) if isinstance(raw, list) else []
    raw = getattr(spec, "files", None) or []
    return list(raw) if isinstance(raw, list) else []


async def _load_policy(org_id: str, policy: dict[str, Any] | None) -> dict[str, Any]:
    if policy is not None:
        return policy
    try:
        from .policy import CodeChangePolicyService
        result = await CodeChangePolicyService().get(org_id)
        if isinstance(result, dict) and isinstance(result.get("data"), dict):
            p = result["data"].get("policy")
            if isinstance(p, dict):
                return p
    except Exception as exc:
        logger.debug("test_runner: policy load failed: %s", exc)
    return dict(DEFAULT_POLICY)


class TestPlanRunner:
    """Generate + run the test plan for a patch."""

    name = "test_plan_runner"

    def __init__(
        self,
        router: ModelRouter | None = None,
    ) -> None:
        self._router = router

    async def generate_plan(
        self,
        org_id: str,
        patch_id: str,
        rca_summary: str,
        diff: str,
    ) -> dict[str, Any]:
        """Generate (don't execute) the targeted test plan. Always works."""
        plan = await _generate_test_plan(
            self._router, rca_summary, diff,
        )
        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "test_plan": plan,
                "count": len(plan),
                "plan_id": _new_id("testplan"),
                "sandbox_required_for_execution": True,
            },
        )

    async def run(
        self,
        org_id: str,
        patch_id: str,
        *,
        spec: Any | None = None,
        policy: dict[str, Any] | None = None,
        files: list[dict[str, Any]] | None = None,
        command: list[str] | None = None,
    ) -> dict[str, Any]:
        """Run the test plan in the local sandbox substitute.

        When ``code_change_enabled`` is false (default), returns
        the deterministic ``gate=3_blocked`` envelope so the
        portal can render "enable code change to run tests".

        When the opt-in is on, delegates to
        :func:`eden.sandbox.runner.run_in_sandbox`.
        """
        resolved_policy = await _load_policy(org_id, policy)
        if not bool(resolved_policy.get("code_change_enabled", False)):
            return _not_implemented_envelope(
                self.name,
                message=(
                    "test plan execution requires code_change_enabled=true; "
                    "sandbox substitute is gated by the Cat 23 master switch"
                ),
                gate="3_blocked",
                data={
                    "patch_id": patch_id,
                    "sandbox_cpu_limit": SANDBOX_CPU_LIMIT,
                    "sandbox_memory_mb": SANDBOX_MEMORY_MB,
                    "sandbox_wall_clock_sec": SANDBOX_WALL_CLOCK_SEC,
                },
            )

        argv = command or _resolve_command(spec)
        patch_files = _resolve_files(spec, files)
        timeout = float(
            (spec.get("timeout_sec") if isinstance(spec, dict) else None)
            or getattr(spec, "timeout_sec", None)
            or SANDBOX_WALL_CLOCK_SEC
        )

        from eden.sandbox.runner import run_in_sandbox

        result = await run_in_sandbox(
            argv,
            files=patch_files,
            timeout_sec=timeout,
        )
        passed, failed, total = _parse_pytest_counts(result.stdout, result.stderr)
        if total == 0:
            # Non-pytest frameworks or empty suites: treat exit code
            # as the pass/fail signal.
            if result.exit_code == 0 and not result.timed_out:
                passed, failed, total = 1, 0, 1
            else:
                passed, failed, total = 0, 1, 1

        pass_rate = (passed / total) if total else 0.0
        run_id = _new_id("testrun")
        sandbox_run_id = _new_id("sbox")
        log_excerpt = (result.stdout[-1500:] + result.stderr[-500:])[-2000:]

        try:
            await _insert_row(
                org_id,
                "patch_test_runs",
                [
                    "id",
                    "patch_id",
                    "sandbox_run_id",
                    "passed_tests",
                    "failed_tests",
                    "total_tests",
                    "lint_violations",
                    "pass_rate",
                    "duration_ms",
                    "log_excerpt",
                ],
                [
                    run_id,
                    patch_id,
                    sandbox_run_id,
                    passed,
                    failed,
                    total,
                    "[]",
                    pass_rate,
                    0,
                    log_excerpt,
                ],
            )
        except Exception as exc:
            logger.debug("test_runner: patch_test_runs persist failed: %s", exc)

        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "run_id": run_id,
                "sandbox_run_id": sandbox_run_id,
                "passed_tests": passed,
                "failed_tests": failed,
                "total_tests": total,
                "pass_rate": pass_rate,
                "exit_code": result.exit_code,
                "timed_out": result.timed_out,
                "isolation": result.isolation,
                "command": result.command,
                "log_excerpt": log_excerpt,
                "sandbox_cpu_limit": SANDBOX_CPU_LIMIT,
                "sandbox_memory_mb": SANDBOX_MEMORY_MB,
                "sandbox_wall_clock_sec": SANDBOX_WALL_CLOCK_SEC,
                "note": (
                    "Gate 3 substitute: subprocess + allowlist + timeout. "
                    "Full Firecracker isolation is a future enhancement."
                ),
            },
        )

    @property
    def provider_name(self) -> str:
        return "sandbox_subprocess"
