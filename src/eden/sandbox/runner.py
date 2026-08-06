"""Isolated subprocess sandbox runner (Gate 3 substitute).

Practical isolation for Cat 23 ``TestPlanRunner.run`` after the
Firecracker / ``sandbox_isolated`` subsystem was retired
(2026-07-04). This module is intentionally pragmatic — it is
**not** a multi-tenant microVM:

* Temp workdir per run (cleaned up on exit); prefers size-capped
  tmpfs (``/dev/shm``) when available (M12, §7.3)
* Patch file application with path-traversal rejection
* Allowlisted commands only (``pytest``, ``npm test``, ``go test``)
* Wall-clock timeout via ``subprocess`` / ``asyncio.wait_for``
* Hard ``ulimit`` via ``setrlimit`` in the spawn preamble
  (CPU seconds, file size, nproc) — M12, §7.3
* Best-effort network isolation via ``unshare --net`` when available
  on Linux (falls back to plain subprocess otherwise)
* Mandatory isolation for synthesis-origin tests
  (``require_isolation=True`` → refuse when unshare unavailable)

Full Firecracker isolation (per-tenant VM, read-only rootfs,
cgroup memory/CPU caps beyond wall-clock timeout) remains a
future enhancement. Production operators should still treat
this runner as a **trusted-operator** surface — enable only
when ``code_change_enabled`` is true.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from eden.realtime import kafka_consumer

logger = logging.getLogger(__name__)

# Default wall-clock budget matches TestPlanRunner.SANDBOX_WALL_CLOCK_SEC.
DEFAULT_TIMEOUT_SEC = 600

# M12 (§7.3): hard resource caps applied in the child via setrlimit.
SANDBOX_CPU_SEC = 120
SANDBOX_FSIZE_BYTES = 64 * 1024 * 1024  # 64 MiB per-file write cap
SANDBOX_NPROC = 256

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


def _is_traversal_error(exc: ValueError) -> bool:
    """Return True when ``exc`` (raised by :func:`_safe_resolve` via
    :func:`apply_patch_files`) represents an actual path-escape attempt,
    as opposed to an ordinary malformed-patch caller error (missing
    ``content``, missing ``path``, non-dict entry, ...). Only real
    escape attempts warrant a P0 security alert.
    """
    message = str(exc)
    return "traversal rejected" in message or "absolute path rejected" in message


async def _emit_sandbox_escape_alert(
    exc: ValueError,
    *,
    workdir: Path,
    command: Sequence[str],
    entity_id: str | None,
    tenant_id: str | None,
) -> None:
    """Publish a P0 ``sandbox.security_alert`` event for a real
    path-escape attempt (FEAT-15), so ``AlertStreamProcessor``'s
    ``rule_sandbox_escape`` rule can fire. Best-effort: a publish
    failure here must never affect the caller's :class:`SandboxResult`.
    """
    try:
        await kafka_consumer.publish_alert_event(
            "sandbox.security_alert",
            entity_id=entity_id,
            tenant_id=tenant_id,
            payload={
                "severity": "critical",
                "message": f"Sandbox path-escape attempt rejected: {exc}",
                "reason": "path_traversal",
                "workdir": str(workdir),
                "command": list(command),
            },
        )
    except Exception:
        logger.warning("failed to publish sandbox.security_alert event", exc_info=True)


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


def _apply_ulimits() -> None:
    """M12 (§7.3): ``preexec_fn`` — hard CPU / file-size / nproc caps.

    Best-effort: some platforms reject individual ``setrlimit`` calls;
    those are skipped without aborting the spawn. No-op when the
    ``resource`` module is unavailable.
    """
    try:
        import resource
    except ImportError:
        return

    def _set(res: int, value: int) -> None:
        try:
            _soft, hard = resource.getrlimit(res)
            # Never raise the existing hard ceiling.
            limit = (
                value
                if hard == resource.RLIM_INFINITY
                else min(value, hard)
            )
            resource.setrlimit(res, (limit, limit))
        except (ValueError, OSError, AttributeError):
            pass

    _set(resource.RLIMIT_CPU, SANDBOX_CPU_SEC)
    _set(resource.RLIMIT_FSIZE, SANDBOX_FSIZE_BYTES)
    nproc = getattr(resource, "RLIMIT_NPROC", None)
    if nproc is not None:
        _set(nproc, SANDBOX_NPROC)


def _alloc_workdir() -> Path:
    """M12 (§7.3): prefer a size-capped tmpfs workdir when available.

    ``/dev/shm`` (and ``/run/shm``) are typically tmpfs with a system
    size cap — good enough without requiring CAP_SYS_ADMIN to mount a
    private tmpfs. Falls back to the default temp dir otherwise.
    """
    for base in ("/dev/shm", "/run/shm"):
        root = Path(base)
        if root.is_dir() and os.access(root, os.W_OK):
            try:
                return Path(
                    tempfile.mkdtemp(prefix="eden-sandbox-", dir=base)
                )
            except OSError:
                continue
    return Path(tempfile.mkdtemp(prefix="eden-sandbox-"))


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


#: Test-file suffix → language key for :func:`build_test_command`.
_TEST_SUFFIX_LANG: tuple[tuple[str, str], ...] = (
    (".py", "python"),
    (".ts", "node"),
    (".tsx", "node"),
    (".js", "node"),
    (".jsx", "node"),
    (".go", "go"),
)


def _test_file_lang(path: str) -> str | None:
    lowered = path.lower()
    for suffix, lang in _TEST_SUFFIX_LANG:
        if lowered.endswith(suffix):
            return lang
    return None


def build_test_command(test_files: Sequence[str]) -> list[str] | None:
    """The allowlisted argv that runs exactly ``test_files`` (M8, §4.2).

    All files must share one language; mixed-language or unknown
    suffixes return ``None`` (caller groups by language first).

    * ``.py`` → ``sys.executable -m pytest -q <files>`` (same
      interpreter as the host so pytest resolves; allowlisted via the
      ``python* -m pytest`` prefix rule).
    * ``.ts/.tsx/.js/.jsx`` → ``npm test -- <files>``
    * ``.go`` → ``go test <files>``
    """
    paths = [str(p).strip() for p in test_files or () if str(p or "").strip()]
    if not paths:
        return None
    langs = {_test_file_lang(p) for p in paths}
    if len(langs) != 1 or None in langs:
        return None
    lang = langs.pop()
    if lang == "python":
        import sys

        return [sys.executable, "-m", "pytest", "-q", *paths]
    if lang == "node":
        return ["npm", "test", "--", *paths]
    if lang == "go":
        return ["go", "test", *paths]
    return None


async def run_in_sandbox(
    command: Sequence[str],
    *,
    files: Sequence[dict[str, Any]] | None = None,
    workdir: str | Path | None = None,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    env: dict[str, str] | None = None,
    cleanup: bool = True,
    require_isolation: bool = False,
    tenant_id: str | None = None,
    entity_id: str | None = None,
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
        require_isolation: §7.3 — refuse to execute at all when
            ``unshare --net`` network isolation is unavailable
            (``error="isolation_unavailable"``, nothing is run).
            Mandatory for LLM-synthesized tests (M8, §4.2).
        tenant_id: Optional tenant id, attached to the P0 security alert
            published for a real path-escape attempt (FEAT-15).
        entity_id: Optional entity id (e.g. job id), attached to the P0
            security alert published for a real path-escape attempt.

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
    # M12 (§7.3): size-capped tmpfs when available.
    root = Path(workdir) if workdir else _alloc_workdir()
    try:
        try:
            written = apply_patch_files(root, files)
        except ValueError as exc:
            if _is_traversal_error(exc):
                await _emit_sandbox_escape_alert(
                    exc,
                    workdir=root,
                    command=command,
                    entity_id=entity_id,
                    tenant_id=tenant_id,
                )
            return SandboxResult(
                exit_code=125,
                stdout="",
                stderr=str(exc),
                workdir=str(root),
                command=list(command),
                error="path_traversal_or_bad_patch",
            )

        argv, isolation = _build_exec_argv(command)
        if require_isolation and isolation != "unshare-net":
            # §7.3: synthesis-origin tests are skipped, never run
            # unisolated. Exit 125 mirrors the other refuse-to-run path.
            return SandboxResult(
                exit_code=125,
                stdout="",
                stderr="network isolation (unshare --net) unavailable",
                workdir=str(root),
                command=list(command),
                isolation=isolation,
                error="isolation_unavailable",
            )
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

        # M12 (§7.3): hard ulimits in the spawn preamble (POSIX only).
        spawn_kwargs: dict[str, Any] = {
            "cwd": str(root),
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
            "env": base_env,
        }
        if os.name == "posix":
            spawn_kwargs["preexec_fn"] = _apply_ulimits

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                **spawn_kwargs,
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
        except TimeoutError:
            timed_out = True
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
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
        require_isolation: bool = False,
        tenant_id: str | None = None,
        entity_id: str | None = None,
    ) -> SandboxResult:
        return await run_in_sandbox(
            command,
            files=files,
            workdir=workdir,
            timeout_sec=self.timeout_sec,
            env=env,
            require_isolation=require_isolation,
            tenant_id=tenant_id,
            entity_id=entity_id,
        )


__all__ = [
    "ALLOWED_COMMAND_PREFIXES",
    "DEFAULT_TIMEOUT_SEC",
    "SANDBOX_CPU_SEC",
    "SANDBOX_FSIZE_BYTES",
    "SANDBOX_NPROC",
    "SandboxResult",
    "SandboxRunner",
    "apply_patch_files",
    "build_test_command",
    "run_in_sandbox",
]
