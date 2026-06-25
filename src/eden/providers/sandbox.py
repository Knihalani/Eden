"""Sandbox provider — general-purpose code execution abstraction.

This module defines the :class:`SandboxProvider` protocol
plus a :class:`LocalSandboxProvider` implementation (uses
``asyncio.create_subprocess_exec`` with ``preexec_fn`` for
rlimits) and a :class:`NullSandboxProvider` for tests +
offline mode.

The provider is a sibling of the existing
:class:`eden.sandbox.runner.SandboxRunner` (Firecracker) and
:class:`eden.sandbox.runner.NullSandboxRunner` (subprocess
fallback for the Tester agent). The two layers coexist:

* ``SandboxRunner`` — the Tester-agent's high-level
  Firecracker abstraction; manages a pool of microVMs.
* ``SandboxProvider`` — the low-level "run one command,
  return one result" contract. Reusable across the platform
  (Cat 12 Simulator, Cat 23 TestPlanRunner, the new
  agent-suggest flow).

The :class:`LocalSandboxProvider` is the dev/CI path — no
Firecracker, no Docker. The :class:`NullSandboxProvider` is
the test/offline path — returns success for any spec.

See ``docs/eden-observability-gap-roadmap.md`` § "v1.3 risks
+ Cat 23" for the sandbox isolation decision (Docker +
iptables for v1, Firecracker in v2 if a breach incident
surfaces).

Example
-------
::

    from eden.providers.sandbox import LocalSandboxProvider, SandboxSpec

    provider = LocalSandboxProvider()
    result = await provider.run(SandboxSpec(
        image="python:3.12",
        command=["python", "-c", "print(2 + 2)"],
        timeout_sec=30,
    ))
    assert result.success
    assert "4" in result.stdout
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import resource
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Protocol

logger = logging.getLogger(__name__)


# ── Spec + Result ──────────────────────────────────────────────────


@dataclass
class SandboxSpec:
    """A single sandbox run specification.

    Attributes:
        image: The image name (e.g. ``"python:3.12"``).
            For :class:`LocalSandboxProvider` and
            :class:`NullSandboxProvider` this is informational
            only — neither pulls images. Future Docker/Firecracker
            providers will use it.
        command: The argv to execute. Each entry is a string.
        env: Environment variables to set on the subprocess.
        workdir: Working directory. Defaults to the current
            working directory.
        timeout_sec: Wall-clock cap. The subprocess is
            killed with SIGKILL if it exceeds this.
        cpu_limit: Soft CPU-seconds cap. Defaults to
            ``None`` (no limit). When set, the subprocess is
            killed with SIGXCPU after ``cpu_limit`` seconds
            of CPU time.
        memory_mb: Soft RSS cap in MB. Defaults to
            ``None`` (no limit). When set, the subprocess
            receives a ``RLIMIT_AS`` cap.
        stdin: Optional stdin payload (bytes).
    """

    image: str = "python:3.12"
    command: Sequence[str] = field(default_factory=tuple)
    env: dict[str, str] = field(default_factory=dict)
    workdir: str | None = None
    timeout_sec: int = 60
    cpu_limit: float | None = None
    memory_mb: int | None = None
    stdin: bytes | None = None


@dataclass
class SandboxResult:
    """The result of a single sandbox run.

    Attributes:
        success: ``True`` if the subprocess exited with
            status 0 and was not killed by a timeout / rlimit.
        exit_code: The subprocess exit code. ``-1`` if
            killed by a signal.
        stdout: Captured stdout (decoded utf-8, lossy).
        stderr: Captured stderr (decoded utf-8, lossy).
        duration_ms: Wall-clock duration in milliseconds.
        timed_out: ``True`` if the run was killed by the
            wall-clock timeout.
        signal: The signal that killed the subprocess, if
            any (``None`` if it exited normally).
        provider: The provider name (for observability —
            ``"local"``, ``"null"``, ``"firecracker"``, ...).
    """

    success: bool
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    signal: int | None = None
    provider: str = "unknown"


# ── Protocol ──────────────────────────────────────────────────────


class SandboxProvider(Protocol):
    """The contract every sandbox implementation must satisfy.

    Implementations: :class:`LocalSandboxProvider`,
    :class:`NullSandboxProvider`, and the future
    Docker / Firecracker providers.
    """

    name: str

    async def run(self, spec: SandboxSpec) -> SandboxResult:
        """Execute ``spec.command`` in a sandbox, return the result.

        Implementations MUST honour the ``timeout_sec`` cap
        (kill the subprocess if it exceeds) and SHOULD
        honour the ``cpu_limit`` and ``memory_mb`` rlimits
        when set. Implementations MUST NOT raise on a
        non-zero exit — the result is returned with
        ``success=False`` and the ``exit_code`` populated.
        """
        ...


# ── LocalSandboxProvider (subprocess + rlimits) ─────────────────────


class LocalSandboxProvider:
    """A :class:`SandboxProvider` backed by ``subprocess``.

    For dev / CI use only. Runs the command directly on the
    host with optional CPU + memory rlimits. NOT a security
    boundary — for production use the Docker / Firecracker
    provider.

    The provider is intentionally cheap to instantiate
    (no socket connection, no pool) so a fresh instance can
    be created per request. The :class:`SandboxRunner`
    Firecracker abstraction (in ``eden.sandbox.runner``) is
    the production path.
    """

    name: str = "local"

    def __init__(self) -> None:
        logger.warning(
            "LocalSandboxProvider initialised — NOT for production "
            "with untrusted code. Use the Docker / Firecracker "
            "provider in production."
        )

    async def run(self, spec: SandboxSpec) -> SandboxResult:
        """Execute ``spec.command`` via ``asyncio.create_subprocess_exec``.

        Steps:
            1. Build the merged env (``os.environ`` + ``spec.env``).
            2. Spawn the subprocess with ``preexec_fn`` for rlimits.
            3. Read stdout + stderr concurrently with a
               ``asyncio.wait_for`` wall-clock timeout.
            4. Return the result.
        """
        if not spec.command:
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="spec.command is empty",
                duration_ms=0,
                provider=self.name,
            )

        merged_env = dict(os.environ)
        merged_env.update(spec.env)

        workdir = spec.workdir if spec.workdir is not None else os.getcwd()
        if not os.path.isdir(workdir):
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"workdir does not exist: {workdir!r}",
                duration_ms=0,
                provider=self.name,
            )

        preexec_fn = self._build_preexec_fn(
            cpu_limit=spec.cpu_limit, memory_mb=spec.memory_mb,
        )
        t0 = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                *spec.command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE if spec.stdin else None,
                env=merged_env,
                cwd=workdir,
                preexec_fn=preexec_fn,
            )
        except FileNotFoundError as exc:
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"executable not found: {exc.filename!r}",
                duration_ms=int((time.monotonic() - t0) * 1000),
                provider=self.name,
            )
        except Exception as exc:  # pragma: no cover - defensive
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"spawn failed: {exc}",
                duration_ms=int((time.monotonic() - t0) * 1000),
                provider=self.name,
            )

        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(input=spec.stdin),
                timeout=spec.timeout_sec,
            )
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            try:
                stdout_b, stderr_b = await asyncio.wait_for(
                    proc.communicate(), timeout=5.0,
                )
            except Exception:
                stdout_b, stderr_b = b"", b""
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout=_decode(stdout_b),
                stderr=_decode(stderr_b),
                duration_ms=int((time.monotonic() - t0) * 1000),
                timed_out=True,
                signal=getattr(proc, "signal", None),
                provider=self.name,
            )

        return SandboxResult(
            success=(proc.returncode == 0),
            exit_code=proc.returncode if proc.returncode is not None else -1,
            stdout=_decode(stdout_b),
            stderr=_decode(stderr_b),
            duration_ms=int((time.monotonic() - t0) * 1000),
            signal=getattr(proc, "signal", None),
            provider=self.name,
        )

    def _build_preexec_fn(
        self,
        *,
        cpu_limit: float | None,
        memory_mb: int | None,
    ) -> Callable[[], None] | None:
        """Build a ``preexec_fn`` that applies the rlimits.

        The closure is intentionally a no-op when neither
        limit is set so the spawn path is identical to a
        plain ``subprocess.Popen`` (no fork overhead).
        """
        if cpu_limit is None and memory_mb is None:
            return None

        def _apply_rlimits() -> None:
            try:
                if cpu_limit is not None:
                    # Set a soft + hard CPU-seconds cap. The
                    # kernel sends SIGXCPU when the soft cap
                    # is exceeded; SIGKILL when the hard
                    # cap is exceeded.
                    cpu_int = int(cpu_limit)
                    resource.setrlimit(resource.RLIMIT_CPU, (cpu_int, cpu_int + 5))
                if memory_mb is not None and memory_mb > 0:
                    mem_bytes = int(memory_mb) * 1024 * 1024
                    resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
            except Exception as exc:  # pragma: no cover
                # Don't fail the spawn on a rlimit error
                # (some kernels / containers reject
                # RLIMIT_AS). Just log.
                logger.debug("LocalSandboxProvider: rlimit set failed: %s", exc)

        return _apply_rlimits


# ── NullSandboxProvider (offline / test) ────────────────────────────


class NullSandboxProvider:
    """A no-op :class:`SandboxProvider` for tests + offline mode.

    Returns ``success=True`` for any spec without
    executing anything. Logs a debug message so the audit
    trail is clear. The :attr:`call_count` attribute lets
    tests assert the provider was invoked.
    """

    name: str = "null"

    def __init__(self) -> None:
        self.call_count: int = 0
        self.last_spec: SandboxSpec | None = None

    async def run(self, spec: SandboxSpec) -> SandboxResult:
        """Return a synthetic success result."""
        self.call_count += 1
        self.last_spec = spec
        logger.debug(
            "NullSandboxProvider.run called for command=%r (call_count=%d)",
            list(spec.command), self.call_count,
        )
        return SandboxResult(
            success=True,
            exit_code=0,
            stdout="",
            stderr="",
            duration_ms=0,
            provider=self.name,
        )


# ── Helpers ────────────────────────────────────────────────────────


def _decode(payload: bytes) -> str:
    """Decode a subprocess stdout / stderr payload.

    Tries utf-8 first, then latin-1 (lossless). Empty
    bytes → empty string. The decode is best-effort so
    the result is always a string (no exception escapes).
    """
    if not payload:
        return ""
    try:
        return payload.decode("utf-8", errors="replace")
    except Exception:  # pragma: no cover - defensive
        return payload.decode("latin-1", errors="replace")


def get_default_sandbox_provider() -> SandboxProvider:
    """The default sandbox provider for the platform.

    Returns :class:`LocalSandboxProvider` when ``eden.sandbox``
    is unconfigured, :class:`NullSandboxProvider` when the
    ``EDEN_SANDBOX_PROVIDER=null`` env var is set, and
    :class:`IsolatedSandboxProvider` (lazy-imported from
    :mod:`eden.providers.sandbox_isolated`) when
    ``EDEN_SANDBOX_PROVIDER=isolated`` is set. The
    Firecracker / Docker providers are wired here when they
    ship.

    Used by the route bootstrap and by the agent-suggest
    flow's default.
    """
    provider = os.environ.get("EDEN_SANDBOX_PROVIDER", "local")
    if provider == "null":
        return NullSandboxProvider()
    if provider == "isolated":
        # Lazy import to avoid pulling the unshare path
        # into the LocalSandboxProvider's import chain.
        from .sandbox_isolated import IsolatedSandboxProvider
        return IsolatedSandboxProvider()
    return LocalSandboxProvider()


__all__ = [
    "LocalSandboxProvider",
    "NullSandboxProvider",
    "SandboxProvider",
    "SandboxResult",
    "SandboxSpec",
    "get_default_sandbox_provider",
]
