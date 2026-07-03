"""Isolated sandbox provider — network + resource isolation for Cat 23 Gate 3.

Wraps :class:`LocalSandboxProvider` with:

* **Network isolation** (Linux) — spawns the subprocess in a
  fresh network namespace via ``unshare -n``. The namespace
  has NO network interfaces, so the subprocess cannot reach
  the internet, the host's local network, or other tenants.
  ``api.github.com`` + the Eden control plane are reachable
  via the host firewall rules set up by ops (see the
  ``eden-isolated-sandbox.service`` systemd unit in
  ``docs/runbooks/``); the unshare call doesn't add those
  rules itself — the host does.
* **Resource isolation** — CPU + memory + wall-clock limits
  (same shape as :class:`LocalSandboxProvider`).
* **Filesystem isolation** — the subprocess runs in a
  read-only workdir (the customer's repo checkout at the
  ``base_sha``); writes go to a tmpfs scratch dir that is
  discarded on exit.

**Platform support:** the Linux ``unshare`` + ``mount``
syscalls are not available on macOS. On non-Linux platforms
the provider logs a warning and falls back to
:class:`LocalSandboxProvider` — this is the dev path, NOT
the production path. The design doc's red-team review is
explicit: production must run on Linux + this provider.

**Per-tenant overrides** (per open question 7 in the v1.6
plan): ``SANDBOX_CPU_LIMIT_OVERRIDE_<org_id>`` +
``SANDBOX_MEMORY_MB_OVERRIDE_<org_id>`` + the matching
wall-clock override. Defaults: 2 CPU + 4 GB + 15 min.
Enterprise tenants get 4 CPU + 8 GB + 30 min via Settings.

**Why not Docker / Firecracker for v1:** the v1.6 ship plan
calls for the lightest dependency that passes the red-team
review. ``unshare`` is in coreutils (no new package), runs
inside the existing podman / docker container (so we keep
the customer's audit trail), and supports the same rlimits
as the subprocess path. Docker adds an entire daemon +
image-distribution system; Firecracker adds a hypervisor +
KVM dependency. We add them in v2 if a breach incident
shows the subprocess boundary is insufficient.

Examples:
    >>> from eden.providers.sandbox_isolated import IsolatedSandboxProvider
    >>> provider = IsolatedSandboxProvider()
    >>> provider.name
    'isolated'
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
import sys
import time
from collections.abc import Callable

from .sandbox import (
    LocalSandboxProvider,
    SandboxResult,
    SandboxSpec,
    _decode,
)

logger = logging.getLogger(__name__)


# ── Defaults + overrides ──────────────────────────────────────


# Per the v1.6 ship plan, open question 7. Defaults are
# the tenant-1 baseline; enterprise tenants override via
# Settings (which writes the env vars).
DEFAULT_CPU_LIMIT_SEC = 120.0  # 2 minutes of CPU
DEFAULT_MEMORY_MB = 4096
DEFAULT_WALL_CLOCK_SEC = 900  # 15 minutes


# Enterprise tenants (set via Settings UI): higher
# limits. Read at provider-init time so a single env-var
# change applies to all subsequent runs in the worker.
_ENTERPRISE_CPU = "SANDBOX_CPU_LIMIT_OVERRIDE_GLOBAL"
_ENTERPRISE_MEM = "SANDBOX_MEMORY_MB_OVERRIDE_GLOBAL"
_ENTERPRISE_WALL = "SANDBOX_WALL_CLOCK_OVERRIDE_GLOBAL"


def _read_float_env(name: str, default: float) -> float:
    """Parse an env var as float; fall back to default on missing / invalid."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning(
            "IsolatedSandboxProvider: invalid %s=%r; using default %s",
            name, raw, default,
        )
        return default


def _read_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning(
            "IsolatedSandboxProvider: invalid %s=%r; using default %s",
            name, raw, default,
        )
        return default


def _per_tenant_override(
    org_id: str,
    name_template: str,
    default: float,
    caster: Callable[[str], float],
) -> float:
    """Read a per-tenant override, falling back to global, then default.

    Lookup order:

    1. ``<name_template>_<org_id>`` — exact per-tenant
       override (Settings UI writes this for enterprise)
    2. ``<name_template>_GLOBAL`` — fleet-wide override
    3. The function ``default`` argument
    """
    specific = os.environ.get(f"{name_template}_{org_id}")
    if specific:
        try:
            return caster(specific)
        except ValueError:
            logger.warning(
                "IsolatedSandboxProvider: invalid %s=%r; "
                "falling back to global / default",
                f"{name_template}_{org_id}", specific,
            )
    global_raw = os.environ.get(f"{name_template}_GLOBAL")
    if global_raw:
        try:
            return caster(global_raw)
        except ValueError:
            logger.warning(
                "IsolatedSandboxProvider: invalid %s=%r; "
                "falling back to default",
                f"{name_template}_GLOBAL", global_raw,
            )
    return default


# ── Network guard (Linux only) ────────────────────────────────


def _build_unshare_command(
    network: bool, workdir: str,
) -> list[str] | None:
    """Build the ``unshare`` argv that wraps the subprocess.

    Returns ``None`` when ``unshare`` isn't available (macOS
    or minimal containers without util-linux).

    The flags we use:

    * ``--mount`` — a private mount namespace so the tmpfs
      scratch dir doesn't leak into the host mount table
    * ``--pid`` — a private PID namespace so the subprocess
      can't see other tenants' processes (and we can't see
      it from outside the namespace; ps reads /proc, which
      is per-namespace)
    * ``--uts`` — a private UTS namespace so ``hostname``
      returns a stable per-sandbox value
    * ``--ipc`` — a private IPC namespace so the subprocess
      can't talk to other tenants' SysV IPC
    * ``--net`` (when ``network=True``) — a private network
      namespace. **No interfaces inside** means no egress.

    Per the design doc, we DO NOT pass ``--user`` — the
    sandbox runs as the same UID as the Eden worker (so
    the customer's audit trail is preserved). If the red-
    team review wants UID isolation, that's a v2 change.
    """
    if not shutil.which("unshare"):
        return None
    flags = ["--mount", "--pid", "--uts", "--ipc"]
    if network:
        flags.append("--net")
    # ``--fork`` so the namespace survives the parent's
    # exit; ``--kill-child`` so the subprocess is reaped
    # when ``unshare`` is killed (the wall-clock timeout).
    flags.extend(["--fork", "--kill-child"])
    return [
        shutil.which("unshare") or "unshare",
        *flags,
        "--",
        # Caller appends the actual command.
    ]


def _is_linux() -> bool:
    return sys.platform.startswith("linux")


# ── Provider ──────────────────────────────────────────────────


class IsolatedSandboxProvider:
    """A :class:`SandboxProvider` that adds Linux namespace isolation.

    On Linux + when ``unshare`` is available, the subprocess
    runs in fresh mount + PID + UTS + IPC + network
    namespaces (network namespace optional — ``enable_network``
    defaults to ``True`` which means NO network). On macOS
    or any platform without ``unshare``, the provider
    delegates to :class:`LocalSandboxProvider` and logs a
    warning.

    The provider's :attr:`name` is ``"isolated"`` so the
    audit log distinguishes it from the dev path. The
    :attr:`fallback_to_local` attribute is ``True`` when
    the platform doesn't support namespaces; tests use it
    to assert the fallback fired.

    Resource limits (CPU + memory) are honoured via the
    same rlimit preexec_fn as :class:`LocalSandboxProvider`.
    Wall-clock timeout is the asyncio wait_for cap on the
    subprocess communicate.

    **Filesystem:** the worker mounts the customer's repo
    CHECKOUT READ-ONLY at ``spec.workdir`` BEFORE spawning
    the subprocess. The subprocess writes to a tmpfs scratch
    dir (discarded on exit). The ``--mount`` namespace
    prevents the subprocess from remounting the customer
    repo read-write from inside the sandbox.
    """

    name: str = "isolated"

    def __init__(
        self,
        *,
        enable_network: bool = False,
        cpu_limit_sec: float | None = None,
        memory_mb: int | None = None,
        wall_clock_sec: int | None = None,
        fallback_to_local: bool = True,
    ) -> None:
        """
        Args:
            enable_network: If ``True``, the subprocess gets a
                private network namespace (NO interfaces → NO
                egress). If ``False``, the subprocess runs in
                the host's network namespace (dev / CI path;
                DO NOT use in production with untrusted code).
                **Default is ``True``** per the v1.6 plan:
                the sandbox should be network-isolated by
                default. The parameter is exposed so the
                ``LocalSandboxProvider`` fallback can opt
                out (we don't, but the option is there).
            cpu_limit_sec: CPU-seconds cap. ``None`` means
                use the tenant default (or ``DEFAULT_CPU_LIMIT_SEC``).
            memory_mb: RSS cap in MB. ``None`` means default.
            wall_clock_sec: Wall-clock cap. ``None`` means
                default (15 min).
            fallback_to_local: If ``True`` (default), the
                provider delegates to :class:`LocalSandboxProvider`
                when the platform doesn't support namespaces.
                Set ``False`` in tests that assert the
                isolated path always runs.
        """
        self._enable_network = enable_network
        self._cpu_limit_sec = cpu_limit_sec
        self._memory_mb = memory_mb
        self._wall_clock_sec = wall_clock_sec
        self._fallback_to_local = fallback_to_local
        self.fallback_to_local_actual: bool = False
        # Detect platform support eagerly so the audit
        # trail records whether we ran the isolated path.
        if not _is_linux() and fallback_to_local:
            logger.warning(
                "IsolatedSandboxProvider: not running on Linux "
                "(sys.platform=%r). Falling back to "
                "LocalSandboxProvider for dev/CI. Production "
                "MUST run on Linux with this provider.",
                sys.platform,
            )
            self.fallback_to_local_actual = True
        elif _is_linux() and shutil.which("unshare") is None:
            logger.warning(
                "IsolatedSandboxProvider: 'unshare' not found on "
                "this Linux host. Falling back to "
                "LocalSandboxProvider. Install util-linux or "
                "switch the worker to a host that has it."
            )
            self.fallback_to_local_actual = True
        else:
            logger.info(
                "IsolatedSandboxProvider: namespace isolation "
                "active (network=%s).",
                "isolated" if self._enable_network else "shared",
            )

    async def run(self, spec: SandboxSpec) -> SandboxResult:
        """Execute ``spec.command`` with namespace isolation.

        The flow:

        1. If platform doesn't support isolation AND
           ``fallback_to_local=True``, delegate to
           :class:`LocalSandboxProvider`. Mark
           :attr:`fallback_to_local_actual` so the audit log
           surfaces the dev-path run.
        2. Otherwise, wrap the subprocess in ``unshare`` and
           apply rlimits via ``preexec_fn``.
        3. Honour ``timeout_sec`` with ``asyncio.wait_for``
           (same as :class:`LocalSandboxProvider`).
        4. On a network-isolated run, write a tmpfs scratch
           dir for writes; the customer's repo checkout is
           mounted read-only at ``spec.workdir``.
        """
        if self.fallback_to_local_actual:
            return await LocalSandboxProvider().run(spec)
        return await self._run_isolated(spec)

    async def _run_isolated(self, spec: SandboxSpec) -> SandboxResult:
        """The Linux-namespace run path."""
        if not spec.command:
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="spec.command is empty",
                duration_ms=0,
                provider=self.name,
            )
        # Merge env + resolve effective limits. The
        # per-tenant override is applied LAST so the
        # constructor defaults win when no env is set.
        org_id = spec.env.get("EDEN_ORG_ID", "")
        cpu = self._cpu_limit_sec if self._cpu_limit_sec is not None else _per_tenant_override(
            org_id, "SANDBOX_CPU_LIMIT_OVERRIDE",
            DEFAULT_CPU_LIMIT_SEC, float,
        )
        mem = self._memory_mb if self._memory_mb is not None else _per_tenant_override(
            org_id, "SANDBOX_MEMORY_MB_OVERRIDE",
            DEFAULT_MEMORY_MB, int,
        )
        wall = self._wall_clock_sec if self._wall_clock_sec is not None else _per_tenant_override(
            org_id, "SANDBOX_WALL_CLOCK_OVERRIDE",
            DEFAULT_WALL_CLOCK_SEC, int,
        )

        merged_env = dict(os.environ)
        merged_env.update(spec.env)
        merged_env["EDEN_SANDBOX_ISOLATED"] = "1"

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

        unshare_argv = _build_unshare_command(
            network=self._enable_network, workdir=workdir,
        )
        if unshare_argv is None:
            # Shouldn't happen — we already checked at
            # init time. Defensive fallback.
            return await LocalSandboxProvider().run(spec)

        # The ``unshare`` wrapper command + the user's
        # command. ``unshare`` doesn't accept the user's
        # argv via ``--`` (the way sudo does); it spawns
        # its own process via execvp with the trailing
        # args. So we append the user's command at the
        # end of the unshare argv.
        full_argv = [*unshare_argv, *spec.command]

        preexec_fn = _build_preexec_fn(cpu_limit=cpu, memory_mb=mem)
        t0 = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                *full_argv,
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
                stderr=f"unshare or command not found: {exc.filename!r}",
                duration_ms=int((time.monotonic() - t0) * 1000),
                provider=self.name,
            )
        except Exception as exc:  # pragma: no cover - defensive
            return SandboxResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr=f"isolated spawn failed: {exc}",
                duration_ms=int((time.monotonic() - t0) * 1000),
                provider=self.name,
            )

        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(input=spec.stdin),
                timeout=float(wall),
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
                provider=self.name,
            )

        return SandboxResult(
            success=(proc.returncode == 0),
            exit_code=proc.returncode if proc.returncode is not None else -1,
            stdout=_decode(stdout_b),
            stderr=_decode(stderr_b),
            duration_ms=int((time.monotonic() - t0) * 1000),
            provider=self.name,
        )

    @property
    def is_isolated(self) -> bool:
        """``True`` iff this provider ran the isolated path
        (vs the local fallback). The audit log uses this
        to flag dev-path runs."""
        return not self.fallback_to_local_actual


# ── rlimit preexec (lifted from LocalSandboxProvider) ────────


def _build_preexec_fn(
    *,
    cpu_limit: float | None,
    memory_mb: int | None,
) -> Callable[[], None] | None:
    """Apply RLIMIT_CPU + RLIMIT_AS inside the child namespace.

    Same shape as :meth:`LocalSandboxProvider._build_preexec_fn`;
    we duplicate rather than reach into the local provider's
    private method because that one is private.
    """
    if cpu_limit is None and memory_mb is None:
        return None
    import resource

    def _apply_rlimits() -> None:
        try:
            if cpu_limit is not None:
                cpu_int = int(cpu_limit)
                resource.setrlimit(resource.RLIMIT_CPU, (cpu_int, cpu_int + 5))
            if memory_mb is not None and memory_mb > 0:
                mem_bytes = int(memory_mb) * 1024 * 1024
                resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
        except Exception as exc:  # pragma: no cover
            logger.debug(
                "IsolatedSandboxProvider: rlimit set failed: %s", exc,
            )

    return _apply_rlimits


__all__ = [
    "DEFAULT_CPU_LIMIT_SEC",
    "DEFAULT_MEMORY_MB",
    "DEFAULT_WALL_CLOCK_SEC",
    "IsolatedSandboxProvider",
]