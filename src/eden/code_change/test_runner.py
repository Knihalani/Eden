"""TestPlanRunner — run the customer's CI suite + Eden's golden test set.

Uses the new :class:`eden.providers.sandbox.SandboxProvider`
abstraction to spin up an isolated container with the
customer's repo checked out at the proposed-patch branch.
Runs (a) the customer's CI test suite (parsed from the
repo's ``.github/workflows/``, ``gitlab-ci.yml``, or
``bitbucket-pipelines.yml``), (b) targeted regression
tests that the :class:`PatchGenerator` specified, and
(c) Eden's golden test suite (synthetic tests for the
specific failure mode in the RCA).

Reports pass/fail counts, per-test duration, and a
``passed`` boolean (overall pass rate ≥
``min_test_pass_rate`` = 0.95). Persists to
``patch_test_runs``. The sandbox enforces the same
per-tenant resource limits as the Cat 12 ``Simulator``
(CPU, memory, wall-clock cap of 10 minutes). A test run
that times out is treated as a failure (don't ship
untested patches).

STUB mode is the canonical example of the v1.6 STUB
checklist constraint: "the STUB surface does NOT
instantiate the sandbox worker; the TestPlanRunner
returns a not_implemented envelope with a
``gate=3_blocked`` marker so it's obvious that real
testing requires Gate 3".

**Provider delegation (v1.7).** The runner now exposes
a ``self._sandbox: SandboxProvider`` (from
:mod:`eden.providers.sandbox`). When a ``spec`` is passed
(the agent-suggest flow), the call delegates to the
provider directly. The STUB surface returns the
gate-3 envelope when no spec is passed.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.providers import (
    SandboxProvider,
    SandboxResult,
    SandboxSpec,
    get_default_sandbox_provider,
)

from ._common import _new_id, _not_implemented_envelope

logger = logging.getLogger(__name__)


# The per-tenant resource limits mirror the Cat 12 ``Simulator``
# defaults. The real Gate-3 implementation will pass these to
# the sandbox runner's resource-limit API.
SANDBOX_CPU_LIMIT = "2.0"
SANDBOX_MEMORY_MB = 4096
SANDBOX_WALL_CLOCK_SEC = 600  # 10 minutes


class TestPlanRunner:
    """Run the CI + regression + golden test suites in a sandbox."""

    name = "test_plan_runner"

    def __init__(
        self,
        provider: SandboxProvider | None = None,
    ) -> None:
        self._sandbox = provider or get_default_sandbox_provider()

    async def run(
        self,
        org_id: str,
        patch_id: str,
        *,
        spec: SandboxSpec | None = None,
    ) -> dict[str, Any]:
        """Spin up the sandbox, run the 3 test suites, persist the result.

        STUB (the existing Cat 23 surface, no ``spec`` provided):
        returns the canonical ``gate=3_blocked`` envelope per the
        v1.6 STUB checklist.

        Real-runner path (a ``spec`` is provided): delegates
        to the :class:`SandboxProvider` and returns the
        :class:`SandboxResult` wrapped in the live envelope.
        """
        if spec is None:
            return _not_implemented_envelope(
                self.name,
                message=(
                    "Test execution requires the sandbox "
                    "worker (Gate 3) to spin up an isolated "
                    "container with the customer's repo "
                    "checked out. The STUB surface "
                    "intentionally does NOT instantiate the "
                    "sandbox worker; real testing requires "
                    "Gate 3 (sandbox safety) to ship first."
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
                    "stub_id": _new_id("testrun_stub"),
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
        """The provider name (``"local"``, ``"null"``, ...)."""
        return self._sandbox.name
