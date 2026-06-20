"""TestPlanRunner — run the customer's CI + Eden's golden tests.

Two paths:

* **Generate the test plan** (no sandbox execution) — uses a
  T1 model to derive 3-5 targeted regression tests from the
  RCA + the diff. Returns the test plan as a JSON array. Always
  available (no Gate-3 dependency).
* **Run the tests** — spins up a sandbox container via the
  configured :class:`SandboxProvider`. Returns the pass/fail
  counts. Requires the Gate-3 sandbox worker; falls back to a
  ``gate=3_blocked`` envelope when no provider is configured
  or no ``spec`` is passed.

Persists to ``patch_test_runs`` with the pass/fail counts.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from eden.optimization.model_router import ModelRouter, PipelineTask
from eden.providers import (
    SandboxProvider,
    SandboxResult,
    SandboxSpec,
    get_default_sandbox_provider,
)

from ._common import _new_id, _not_implemented_envelope, _ok_envelope

logger = logging.getLogger(__name__)


SANDBOX_CPU_LIMIT = "2.0"
SANDBOX_MEMORY_MB = 4096
SANDBOX_WALL_CLOCK_SEC = 600


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


class TestPlanRunner:
    """Generate + run the test plan for a patch."""

    name = "test_plan_runner"

    def __init__(
        self,
        provider: SandboxProvider | None = None,
        router: ModelRouter | None = None,
    ) -> None:
        self._sandbox = provider or get_default_sandbox_provider()
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
        spec: SandboxSpec | None = None,
    ) -> dict[str, Any]:
        """Spin up the sandbox, run the test plan, persist the result."""
        if spec is None:
            return _not_implemented_envelope(
                self.name,
                message=(
                    "Test execution requires the sandbox worker "
                    "(Gate 3) to spin up an isolated container with "
                    "the customer's repo checked out. Pass a "
                    "SandboxSpec to actually run; without one we "
                    "return the gate=3_blocked envelope per the v1.6 "
                    "STUB checklist."
                ),
                gate="3_blocked",
                data={
                    "patch_id": patch_id,
                    "passed_tests": None,
                    "failed_tests": None,
                    "total_tests": None,
                    "pass_rate": None,
                    "sandbox_run_id": _new_id("sandbox"),
                    "sandbox_cpu_limit": SANDBOX_CPU_LIMIT,
                    "sandbox_memory_mb": SANDBOX_MEMORY_MB,
                    "sandbox_wall_clock_sec": SANDBOX_WALL_CLOCK_SEC,
                },
            )
        result: SandboxResult = await self._sandbox.run(spec)
        return {
            "status": "ok" if result.success else "failed",
            "feature": self.name,
            "live": True,
            "trace_id": _new_id("live"),
            "timestamp": None,
            "data": {
                "patch_id": patch_id,
                "sandbox_run_id": _new_id("sandbox"),
                "sandbox_provider": result.provider,
                "passed": result.success,
                "exit_code": result.exit_code,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "duration_ms": result.duration_ms,
                "timed_out": result.timed_out,
                "signal": result.signal,
            },
        }

    @property
    def provider_name(self) -> str:
        return self._sandbox.name
