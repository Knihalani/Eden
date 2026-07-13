"""Isolated subprocess sandbox runner (Gate 3 substitute).

Practical isolation for Cat 23 ``TestPlanRunner.run`` after the
Firecracker / ``sandbox_isolated`` subsystem was retired
(2026-07-04). This module is intentionally pragmatic — it is
**not** a multi-tenant microVM:

* Temp workdir per run (cleaned up on exit)
* Patch file application with path-traversal rejection
* Allowlisted commands only (``pytest``, ``npm test``, ``go test``)
* Wall-clock timeout via ``subprocess`` / ``asyncio.wait_for``
* Best-effort network isolation via ``unshare --net`` when available
  on Linux (falls back to plain subprocess otherwise)

Full Firecracker isolation (per-tenant VM, read-only rootfs,
cgroup memory/CPU caps beyond wall-clock timeout) remains a
future enhancement. Production operators should still treat
this runner as a **trusted-operator** surface — enable only
when ``code_change_enabled`` is true.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

logger = logging.getLogger(__name__)

# Default wall-clock budget matches TestPlanRunner.SANDBOX_WALL_CLOCK_SEC.
DEFAULT_TIMEOUT_SEC = 600

# Commands the sandbox is allowed to exec. Each entry is the
# argv prefix that must match exactly (case-sensitive). Extra
# trailing args (test paths, -q, ./...) are allowed.
ALLOWED_COMMAND_PREFIXES: tuple[tuple[str, ...], ...] = (
    ("pytest",),
    ("python", "-m", "pytest"),
    ("python3", "-m", "pytest"),
    ("npm", "test"),
    ("npm", "run", "test"),
    ("go", "test"),
)


@dataclass
class SandboxResult:
    """Captured outcome of one sandbox invocation."""

    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False
    workdir: str = ""
    command: list[str] = field(default_factory=list)
    isolation: str = "subprocess"  # or "unshare-net"
    error: str | None = None

    @property
    def passed(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    def to_dict(self) -> dict[str, Any]:
        return {
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "timed_out": self.timed_out,
            "workdir": self.workdir,
            "command": list(self.command),
            "isolation": self.isolation,
            "error": self.error,
            "passed": self.passed,
        }


def _is_allowed_command(command: Sequence[str]) -> bool:
    """Return True when ``command`` matches an allowlisted prefix."""
    if not command:
        return False
    argv = tuple(str(c) for c in command)
    for prefix in ALLOWED_COMMAND_PREFIXES:
        if len(argv) >= len(prefix) and argv[: len(prefix)] == prefix:
            return True
    # ``sys.executable -m pytest ...`` — executable path varies by venv.
    if len(argv) >= 3 and argv[1] == "-m" and argv[2] == "pytest":
        base = os.path.basename(argv[0])
        if base in {"python", "python3"} or base.startswith("python"):
            return True
    return False


def _safe_resolve(workdir: Path, rel_path: str) -> Path:
    """Resolve ``rel_path`` under ``workdir``, rejecting traversal.

    Raises:
        ValueError: if the path escapes the workdir or is absolute.
    """
    if not rel_path or rel_path.strip() == "":
        raise ValueError("empty patch path")
    # Normalise separators; reject absolute / drive-letter paths.
    normalised = rel_path.replace("\\", "/").lstrip("/")
    if normalised.startswith("..") or "/../" in f"/{normalised}/":
        # Still resolve + check containment below for ``a/../../etc``.
        pass
    candidate = (workdir / normalised).resolve()
    workdir_resolved = workdir.resolve()
    try:
        candidate.relative_to(workdir_resolved)
    except ValueError as exc:
        raise ValueError(
            f"path traversal rejected: {rel_path!r}"
        ) from exc
    if os.path.isabs(rel_path) and not str(candidate).startswith(
        str(workdir_resolved)
    ):
        raise ValueError(f"absolute path rejected: {rel_path!r}")
    return candidate


def apply_patch_files(
    workdir: str | Path,
    files: Sequence[dict[str, Any]] | None,
) -> list[str]:
    """Write patch files into ``workdir``, rejecting path traversal.

    Each entry is a dict with ``path`` (relative) and ``content``
    (str). Returns the list of written relative paths.

    Raises:
        ValueError: on path traversal or missing path/content.
    """
    root = Path(workdir)
    root.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for entry in files or ():
        if not isinstance(entry, dict):
            raise ValueError(f"patch entry must be a dict, got {type(entry)}")
        rel = entry.get("path") or entry.get("file_path")
        if not isinstance(rel, str):
            raise ValueError("patch entry missing string 'path'")
        content = entry.get("content")
        if content is None:
            raise ValueError(f"patch entry for {rel!r} missing 'content'")
        target = _safe_resolve(root, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(content), encoding="utf-8")
        written.append(rel.replace("\\", "/"))
    return written


def _unshare_net_available() -> bool:
    """Return True when ``unshare --net`` actually works.

    Many CI / cloud-agent environments ship the binary but
    deny the namespace operation (EPERM). Probe once and cache.
    """
    global _UNSHARE_NET_OK
    if _UNSHARE_NET_OK is not None:
        return _UNSHARE_NET_OK
    unshare = shutil.which("unshare")
    if not unshare or os.name != "posix":
        _UNSHARE_NET_OK = False
        return False
    try:
        import subprocess as _sp
        probe = _sp.run(
            [unshare, "--net", "--", "true"],
            capture_output=True,
            timeout=2,
            check=False,
        )
        _UNSHARE_NET_OK = probe.returncode == 0
    except Exception:
        _UNSHARE_NET_OK = False
    return _UNSHARE_NET_OK


_UNSHARE_NET_OK: bool | None = None


def _build_exec_argv(command: Sequence[str]) -> tuple[list[str], str]:
    """Wrap ``command`` with ``unshare --net`` when available.

    Returns ``(argv, isolation_label)``.
    """
    argv = [str(c) for c in command]
    if _unshare_net_available():
        unshare = shutil.which("unshare")
        assert unshare is not None
        return [unshare, "--net", "--"] + argv, "unshare-net"
    return argv, "subprocess"


async def run_in_sandbox(
    command: Sequence[str],
    *,
    files: Sequence[dict[str, Any]] | None = None,
    workdir: str | Path | None = None,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    env: dict[str, str] | None = None,
    cleanup: bool = True,
) -> SandboxResult:
    """Create a temp workdir, apply patches, run an allowlisted command.

    Args:
        command: Allowlisted argv (``pytest``, ``npm test``, …).
        files: Optional patch files ``[{path, content}, ...]``.
        workdir: Optional existing workdir. When ``None``, a temp
            directory is created (and removed when ``cleanup``).
        timeout_sec: Wall-clock timeout.
        env: Extra env vars (merged over a scrubbed base). Secrets
            should not be passed — caller responsibility.
        cleanup: Remove the temp workdir after the run.

    Returns:
        :class:`SandboxResult` with stdout/stderr/exit_code.
    """
    if not _is_allowed_command(command):
        return SandboxResult(
            exit_code=126,
            stdout="",
            stderr=f"command not allowlisted: {list(command)!r}",
            command=list(command),
            error="command_not_allowlisted",
        )

    owns_workdir = workdir is None
    root = Path(workdir) if workdir else Path(
        tempfile.mkdtemp(prefix="eden-sandbox-")
    )
    try:
        try:
            written = apply_patch_files(root, files)
        except ValueError as exc:
            return SandboxResult(
                exit_code=125,
                stdout="",
                stderr=str(exc),
                workdir=str(root),
                command=list(command),
                error="path_traversal_or_bad_patch",
            )

        argv, isolation = _build_exec_argv(command)
        # Scrubbed env: inherit PATH/HOME/LANG so pytest/npm/go
        # resolve, drop obvious credential-bearing vars.
        base_env = {
            k: v
            for k, v in os.environ.items()
            if k in {"PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "TMPDIR"}
            or k.startswith("PYTEST_")
            or k.startswith("NODE_")
            or k.startswith("GOPATH")
            or k.startswith("GOROOT")
            or k == "npm_config_cache"
        }
        base_env["EDEN_SANDBOX"] = "1"
        if env:
            base_env.update(env)

        logger.debug(
            "sandbox.run cmd=%s workdir=%s files=%s isolation=%s",
            argv, root, written, isolation,
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(root),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=base_env,
            )
        except FileNotFoundError as exc:
            return SandboxResult(
                exit_code=127,
                stdout="",
                stderr=f"executable not found: {exc}",
                workdir=str(root),
                command=list(command),
                isolation=isolation,
                error="executable_not_found",
            )

        timed_out = False
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(), timeout=float(timeout_sec),
            )
        except asyncio.TimeoutError:
            timed_out = True
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                stdout_b, stderr_b = await asyncio.wait_for(
                    proc.communicate(), timeout=5.0,
                )
            except Exception:
                stdout_b, stderr_b = b"", b""

        exit_code = (
            124 if timed_out
            else (proc.returncode if proc.returncode is not None else 1)
        )
        return SandboxResult(
            exit_code=exit_code,
            stdout=(stdout_b or b"").decode("utf-8", errors="replace"),
            stderr=(stderr_b or b"").decode("utf-8", errors="replace"),
            timed_out=timed_out,
            workdir=str(root),
            command=list(command),
            isolation=isolation,
            error="timed_out" if timed_out else None,
        )
    finally:
        if owns_workdir and cleanup:
            shutil.rmtree(root, ignore_errors=True)


class SandboxRunner:
    """Thin OO wrapper around :func:`run_in_sandbox`."""

    name = "sandbox_runner"

    def __init__(self, timeout_sec: float = DEFAULT_TIMEOUT_SEC) -> None:
        self.timeout_sec = timeout_sec

    async def run(
        self,
        command: Sequence[str],
        *,
        files: Sequence[dict[str, Any]] | None = None,
        workdir: str | Path | None = None,
        env: dict[str, str] | None = None,
    ) -> SandboxResult:
        return await run_in_sandbox(
            command,
            files=files,
            workdir=workdir,
            timeout_sec=self.timeout_sec,
            env=env,
        )


__all__ = [
    "ALLOWED_COMMAND_PREFIXES",
    "DEFAULT_TIMEOUT_SEC",
    "SandboxResult",
    "SandboxRunner",
    "apply_patch_files",
    "run_in_sandbox",
]
