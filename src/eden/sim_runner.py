"""Phase 3: Sim execution adapters.

When a user triggers ``/orgs/{org_id}/agents/{agent_id}/sim/runs``
on the server, the route dispatches the run to one of these
adapters. The route picks the first adapter that is ``available()``;
if the Firecracker adapter is not reachable, it falls back to the
subprocess adapter. Both adapters share the same :class:`SimRunResult`
shape so the route + persistence layer is uniform.

Security note
-------------
The :class:`SubprocessSimAdapter` runs user-uploaded code without
sandboxing. It is intended for **dev/eval** use only — for untrusted
public agents, the Firecracker adapter (or an equivalent sandbox)
MUST be used. The route handler enforces a per-org ``sim_runner_kind``
config so a single org can opt in to subprocess-only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger("eden.sim_runner")


# ── Result dataclass ──────────────────────────────────────────────


@dataclass
class ScenarioRunResult:
    """One scenario's result."""

    scenario_id: str
    status: str  # "passed" | "failed" | "error"
    episodes: int = 0
    passed_steps: int = 0
    failed_steps: int = 0
    output: str = ""
    error: str = ""


@dataclass
class SimRunResult:
    """Structured result of a sim or test run."""

    kind: str  # "sim" | "test"
    status: str  # "passed" | "failed" | "error"
    duration_ms: int = 0
    scenarios: list[ScenarioRunResult] = field(default_factory=list)
    summary: str = ""
    stdout: str = ""
    stderr: str = ""
    error: str = ""
    raw_results: dict[str, Any] = field(default_factory=dict)

    def to_results_jsonb(self) -> dict[str, Any]:
        """Shape that goes into sim_runs.results (JSONB)."""
        return {
            "kind": self.kind,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "summary": self.summary,
            "stdout": self.stdout[-4000:],  # cap so we don't blow up JSONB
            "stderr": self.stderr[-4000:],
            "error": self.error,
            "scenarios": [
                {
                    "scenario_id": s.scenario_id,
                    "status": s.status,
                    "episodes": s.episodes,
                    "passed_steps": s.passed_steps,
                    "failed_steps": s.failed_steps,
                    "output": s.output[-2000:],
                    "error": s.error,
                }
                for s in self.scenarios
            ],
            "raw": self.raw_results,
        }


# ── Adapter Protocol ─────────────────────────────────────────────


def _seed_env(eval_yaml: dict | None) -> dict | None:
    """Return a child-process env dict carrying ``EDEN_SEED`` if
    the spec carries a non-negative integer ``seed:`` field.

    Returns ``None`` when no seed is set so the child inherits
    the parent env (the original behaviour).
    """
    if not eval_yaml:
        return None
    raw = eval_yaml.get("seed")
    if raw is None:
        return None
    try:
        seed_int = int(raw)
    except (TypeError, ValueError):
        return None
    if seed_int < 0:
        return None
    return {**os.environ, "EDEN_SEED": str(seed_int)}


class SimExecutionAdapter(Protocol):
    """The interface the route handler dispatches to.

    Both methods take the on-disk path to the uploaded agent code
    (already extracted) and the parsed ``eden-sim-eval.yaml`` dict.
    """

    name: str

    def available(self) -> bool:
        """Return True if this adapter can run in the current env."""
        ...

    async def run_scenarios(
        self,
        *,
        upload_path: Path,
        eval_yaml: dict,
    ) -> SimRunResult:
        """Execute the YAML's scenarios against the uploaded agent.

        For each ``scenarios[*]`` in the YAML, the adapter imports
        the agent module, instantiates the env class, and runs
        ``reset()`` + ``step()`` for ``max_episodes`` episodes.
        """
        ...

    async def run_tests(
        self,
        *,
        upload_path: Path,
        eval_yaml: dict,
    ) -> SimRunResult:
        """Execute the YAML's pytest wrapper tests."""
        ...


# ── Subprocess adapter (no isolation; dev/eval only) ─────────────


class SubprocessSimAdapter:
    """Runs the agent in a Python subprocess inside a fresh venv,
    with requirements.txt pip-installed.

    Best-effort: when pip install fails, the run still proceeds with
    the system Python (the error is captured in the result).
    """

    name: str = "subprocess"
    pip_timeout_s: int = 180
    episode_timeout_s: int = 30
    max_episodes: int = 5

    def available(self) -> bool:
        return shutil.which("python") is not None or shutil.which("python3") is not None

    def _python(self) -> str:
        return shutil.which("python") or shutil.which("python3") or "python"

    async def _ensure_requirements(
        self, upload_path: Path, venv_python: str
    ) -> str:
        """Best-effort: pip install -r requirements.txt into the venv.

        Returns a note (empty if successful, error description otherwise).
        """
        req = upload_path / "requirements.txt"
        if not req.exists():
            return ""
        try:
            proc = await asyncio.create_subprocess_exec(
                venv_python, "-m", "pip", "install", "-q", "-r", str(req),
                cwd=str(upload_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=self.pip_timeout_s
                )
            except TimeoutError:
                proc.kill()
                return f"pip install timed out after {self.pip_timeout_s}s"
            if proc.returncode != 0:
                return (
                    f"pip install failed (rc={proc.returncode}): "
                    + (stderr.decode("utf-8", errors="replace")[:1000] or "(no stderr)")
                )
            return ""
        except Exception as exc:  # noqa: BLE001
            return f"pip install error: {exc!r}"

    async def _run_pytest(
        self, upload_path: Path, venv_python: str,
        subprocess_env: dict | None = None,
    ) -> tuple[int, bytes, bytes]:
        """Run ``pytest`` in the upload directory. Returns
        ``(returncode, stdout, stderr)`` as ``bytes`` so callers can
        decode with the encoding they want.

        ``subprocess_env`` is forwarded to the child process so
        the visual builder's ``seed:`` field (delivered as the
        ``EDEN_SEED`` env var) can pin ``random.seed`` in the
        user's pytest collection.
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                venv_python, "-m", "pytest", "-x", "-q", "--tb=short",
                cwd=str(upload_path),
                env=subprocess_env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=self.episode_timeout_s * 6
                )
            except TimeoutError:
                proc.kill()
                return -1, b"", b"pytest timed out"
            return proc.returncode, stdout, stderr
        except Exception as exc:  # noqa: BLE001
            return -1, b"", str(exc).encode()

    async def _run_scenario(
        self,
        upload_path: Path,
        venv_python: str,
        scenario: dict,
        subprocess_env: dict | None = None,
    ) -> ScenarioRunResult:
        """Run a single scenario: import the env class, run episodes.

        ``subprocess_env`` is forwarded to the child process so
        the visual builder's ``seed:`` field (delivered as the
        ``EDEN_SEED`` env var) is visible to the generated
        driver — the driver calls ``random.seed(int(EDEN_SEED))``
        before any user-level randomness runs.
        """
        sid = scenario.get("id", "unknown")
        scenario.get("env_class_name", "SimEnv")
        result = ScenarioRunResult(scenario_id=sid, status="error")
        try:
            # Write a small driver script that imports + runs the
            # env class for N episodes, prints a JSON line per
            # episode, exits 0 on all-pass / 1 on any-fail.
            driver = upload_path / "_eden_driver.py"
            driver.write_text(
                "import json, sys, importlib.util, pathlib\n"
                "spec = importlib.util.spec_from_file_location("
                "'_ed', pathlib.Path(sys.argv[1]).read_text() or '')\n"
                "raise SystemExit(0)\n"  # placeholder
            )
            # The proper driver is generated per-scenario so it can
            # instantiate the right env class.
            driver.write_text(self._driver_for(scenario))
            proc = await asyncio.create_subprocess_exec(
                venv_python, str(driver),
                cwd=str(upload_path),
                env=subprocess_env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=self.episode_timeout_s
                )
            except TimeoutError:
                proc.kill()
                result.status = "error"
                result.error = f"timed out after {self.episode_timeout_s}s"
                return result

            result.output = stdout.decode("utf-8", errors="replace")[:2000]
            err_text = stderr.decode("utf-8", errors="replace")[:2000]

            if proc.returncode == 0:
                result.status = "passed"
                result.passed_steps = result.episodes
            else:
                result.status = "failed"
                result.failed_steps = max(result.episodes, 1)
                result.error = err_text

            # Try to parse the JSON line(s) the driver emits
            for line in result.output.splitlines():
                line = line.strip()
                if line.startswith("EDEN_RESULT "):
                    try:
                        d = json.loads(line[len("EDEN_RESULT "):])
                        result.episodes = int(d.get("episodes", result.episodes))
                        result.passed_steps = int(d.get("passed_steps", result.passed_steps))
                        result.failed_steps = int(d.get("failed_steps", result.failed_steps))
                    except Exception:  # noqa: BLE001
                        pass
        except Exception as exc:  # noqa: BLE001
            result.status = "error"
            result.error = f"{type(exc).__name__}: {exc}"
        return result

    def _driver_for(self, scenario: dict) -> str:
        """Generate a per-scenario driver script. The driver emits a
        ``EDEN_RESULT {json}`` line so the parent can read structured
        results without parsing the agent's stdout format.

        If the upload's ``eden-sim-eval.yaml`` carries a
        ``seed:`` field, the runner sets ``EDEN_SEED`` in the
        subprocess env; the driver reads it and calls
        ``random.seed(int(seed))`` *before* any user code runs,
        so the env's randomness is reproducible across replays.
        """
        sid = scenario.get("id", "unknown")
        env_class = scenario.get("env_class_name", "SimEnv")
        max_eps = min(int(scenario.get("max_episodes", self.max_episodes)), 50)
        return f'''\
import os, random
_seed = os.environ.get("EDEN_SEED")
if _seed is not None:
    try:
        random.seed(int(_seed))
    except (TypeError, ValueError):
        pass
import json, importlib.util, sys, traceback
try:
    spec = importlib.util.spec_from_file_location("_ed_scenario", "scenarios/{sid}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    env_cls = getattr(mod, "{env_class}")
except Exception as e:
    print("EDEN_RESULT " + json.dumps({{"episodes": 0, "passed_steps": 0, "failed_steps": 0, "error": f"{{type(e).__name__}}: {{e}}"}}))
    sys.exit(1)
passed = 0
failed = 0
try:
    env = env_cls()
    obs, info = env.reset()
    for ep in range({max_eps}):
        try:
            obs2, reward, terminated, truncated, info = env.step(None)
            passed += 1
            if terminated or truncated:
                break
        except Exception as e:
            failed += 1
            break
except Exception as e:
    failed += 1
    print("EDEN_RESULT " + json.dumps({{"episodes": 0, "passed_steps": 0, "failed_steps": 1, "error": f"{{type(e).__name__}}: {{e}}"}}))
    sys.exit(1)
print("EDEN_RESULT " + json.dumps({{"episodes": {max_eps}, "passed_steps": passed, "failed_steps": failed}}))
sys.exit(0 if failed == 0 else 1)
'''

    async def run_scenarios(
        self,
        *,
        upload_path: Path,
        eval_yaml: dict,
    ) -> SimRunResult:
        t0 = time.time()
        scenarios_cfg = eval_yaml.get("scenarios") or []
        if not scenarios_cfg:
            return SimRunResult(
                kind="sim", status="passed", duration_ms=0,
                summary="no scenarios in eval_yaml",
            )

        venv_python = self._python()
        note = await self._ensure_requirements(upload_path, venv_python)
        subprocess_env = _seed_env(eval_yaml)
        results: list[ScenarioRunResult] = []
        for sc in scenarios_cfg:
            r = await self._run_scenario(
                upload_path, venv_python, sc,
                subprocess_env=subprocess_env,
            )
            results.append(r)

        duration = int((time.time() - t0) * 1000)
        passed = sum(1 for r in results if r.status == "passed")
        failed = sum(1 for r in results if r.status == "failed")
        errored = sum(1 for r in results if r.status == "error")
        if errored:
            status = "error"
        elif failed:
            status = "failed"
        else:
            status = "passed"
        summary = f"{passed}/{len(results)} scenarios passed"
        if note:
            summary += f" — {note}"
        return SimRunResult(
            kind="sim",
            status=status,
            duration_ms=duration,
            scenarios=results,
            summary=summary,
            error=note,
        )

    async def run_tests(
        self,
        *,
        upload_path: Path,
        eval_yaml: dict,
    ) -> SimRunResult:
        t0 = time.time()
        venv_python = self._python()
        note = await self._ensure_requirements(upload_path, venv_python)
        subprocess_env = _seed_env(eval_yaml)
        rc, stdout, stderr = await self._run_pytest(
            upload_path, venv_python,
            subprocess_env=subprocess_env,
        )
        duration = int((time.time() - t0) * 1000)
        out = stdout.decode("utf-8", errors="replace")
        err = stderr.decode("utf-8", errors="replace")
        status = "passed" if rc == 0 else ("error" if rc < 0 else "failed")
        return SimRunResult(
            kind="test",
            status=status,
            duration_ms=duration,
            summary=f"pytest rc={rc}",
            stdout=out,
            stderr=err,
            error=note,
        )





def select_adapter(
    preferred: str | None = None,
) -> SimExecutionAdapter:
    """Return the best available adapter.

    Only :class:`SubprocessSimAdapter` is supported as of the June 2026
    cleanup (the FirecrackerSimAdapter stub was removed — BandSox
    protocol extension not on the roadmap). Use the sandbox provider
    abstraction in :mod:`eden.providers.sandbox` if you need a
    different isolation backend.
    """
    sp = SubprocessSimAdapter()
    if preferred == "subprocess" or preferred is None:
        return sp
    if preferred == "firecracker":
        raise RuntimeError(
            "Firecracker adapter was removed in the June 2026 prod-readiness "
            "pass. Use the sandbox provider abstraction in eden.providers.sandbox."
        )
    raise ValueError(f"Unknown adapter preference: {preferred!r}")


# ── LocalProviderSimAdapter (v1.7) ───────────────────────────────


class LocalProviderSimAdapter:
    """Adapter that delegates to :class:`eden.providers.sandbox.SandboxProvider`.

    Sits alongside :class:`SubprocessSimAdapter` so the Cat 12 sim route
    can pick a uniform adapter surface while the underlying
    sandbox goes through the new provider abstraction.

    The adapter wraps the provider in the
    :class:`SimRunResult` envelope so the existing route
    handler is unchanged. ``available()`` returns ``True``
    when the provider is reachable (i.e. the local
    subprocess runner is installed).
    """

    name: str = "local_provider"

    def __init__(self, provider: Any = None) -> None:
        if provider is None:
            try:
                from eden.providers import get_default_sandbox_provider
                provider = get_default_sandbox_provider()
            except Exception:
                provider = None
        self._provider = provider

    def available(self) -> bool:
        return self._provider is not None

    async def run_scenarios(
        self,
        *,
        upload_path: Path,
        eval_yaml: dict,
    ) -> SimRunResult:
        """Run the eval's scenarios via the sandbox provider.

        The adapter is a thin shim — the actual scenario
        loop lives in the :class:`SubprocessSimAdapter`
        and the new Cat 12 :class:`Simulator` in
        ``eden.experiments.simulation``. This adapter
        exists so the route can validate the provider is
        wired without changing the rest of the path.
        """
        if not self.available():
            return SimRunResult(
                scenarios=[], n_passed=0, n_failed=0,
                total=0, duration_ms=0, provider="none",
                stderr="", error="LocalProviderSimAdapter: no provider",
            )
        # A single 0-arg probe to confirm the provider is
        # alive. The real scenario loop is out of scope for
        # this rewire (the v1.7 ship keeps the existing
        # SubprocessSimAdapter for the actual eval work).
        from eden.providers import SandboxSpec
        try:
            result = await self._provider.run(
                SandboxSpec(
                    image="local-probe",
                    command=["true"],
                    timeout_sec=5,
                ),
            )
        except Exception as exc:
            return SimRunResult(
                scenarios=[], n_passed=0, n_failed=0,
                total=0, duration_ms=0,
                provider=self._provider.name,
                stderr=str(exc),
                error="probe failed",
            )
        return SimRunResult(
            scenarios=[],
            n_passed=1 if result.success else 0,
            n_failed=0 if result.success else 1,
            total=1,
            duration_ms=result.duration_ms,
            provider=result.provider,
            stderr=result.stderr,
            error=(None if result.success else "probe returned non-zero"),
        )
