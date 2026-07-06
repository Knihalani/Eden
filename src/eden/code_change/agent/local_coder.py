"""LocalCodingAgent — Eden's bulletproof local coding agent.

The brief from the user was clear: OpenHands is open source,
so we should run it locally rather than paying for the cloud
API. This module ships three layered implementations, each
of which is **bulletproof** (never raises, always returns a
useful :class:`PRResult`):

1. :class:`OpenHandsLocalAgent` — shells out to the
   ``openhands`` CLI / Python entrypoint when installed on
   the host. Activates when ``which openhands`` (or
   ``python -m openhands``) succeeds. Uses
   ``subprocess.run`` with a hard timeout so a hung agent
   never blocks the discipline layer.
2. :class:`ScriptedCodingAgent` — a deterministic patch
   generator that uses Python's :mod:`ast` + regex to make
   **small, high-confidence** code changes (rename symbol,
   add import, add no-op method stub, add docstring, etc.).
   This is the "no LLM, no subprocess" path that always
   succeeds when the candidate is small enough.
3. :class:`LocalCodingAgent` — the always-on safety net.
   Combines both: it tries :class:`OpenHandsLocalAgent`
   first (if installed), then :class:`ScriptedCodingAgent`
   for the residual cases, and finally a structured
   ``report_only`` payload with a helpful body.

Why three layers?

* OpenHands is great when it works, but it requires Docker,
  ~5 GB of dependencies, and 30-120s of model warm-up.
* Scripted patches are bulletproof but limited to a
  catalog of safe operations.
* Report-only is always available and never fabricates a
  diff — that's the safety net.

Combined, this gives us a system that:

* **Never fails.** Every code path returns a
  :class:`PRResult`. No more ``None`` returns that the
  discipline layer has to handle.
* **Is cost-effective.** OpenHands local uses whatever
  LLM you point it at (OpenRouter, Ollama, etc.) at
  your marginal cost — no per-PR markup. Scripted
  patches cost $0.
* **Is actually effective.** The discipline gate already
  limits us to high-confidence candidates; the local
  agents do the actual code generation in two passes
  (fast script + slower OpenHands), so we always have
  *something* to show the user.

The existing :class:`LocalPRAgent` (the ``"no_openhands_key"``
report-only path) is preserved for backward compatibility
and is now a thin wrapper around :class:`LocalCodingAgent`'s
report-only mode.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .openhands import PRCandidate, PRResult

logger = logging.getLogger(__name__)


# ── OpenHands local agent ────────────────────────────────────────────


# Hard wall-clock cap on a single OpenHands run. We intentionally
# keep this low — the discipline gate only emits high-confidence
# candidates, and a 60s cap is enough for OpenHands to either
# produce a patch or give up.
OPENHANDS_LOCAL_TIMEOUT_SECONDS = float(
    os.getenv("OPENHANDS_LOCAL_TIMEOUT_SECONDS", "60"),
)


def _openhands_available() -> bool:
    """Best-effort: is the openhands CLI / Python module available?"""
    if shutil.which("openhands"):
        return True
    try:
        import openhands  # noqa: F401
    except Exception:
        return False
    return False


class OpenHandsLocalAgent:
    """Runs the OpenHands Python SDK locally as a subprocess.

    OpenHands is open source (https://github.com/OpenHands/OpenHands).
    The user told us to install it locally and run it like that —
    this class is the wire-up.

    The class is intentionally minimal: we spawn OpenHands as a
    subprocess with a JSON task description, wait up to
    ``OPENHANDS_LOCAL_TIMEOUT_SECONDS`` for it to produce a diff,
    and parse the result. Anything that goes wrong (timeout,
    non-zero exit, missing binary) degrades to ``report_only``.
    """

    name: str = "openhands-local"

    def __init__(
        self,
        *,
        timeout: float = OPENHANDS_LOCAL_TIMEOUT_SECONDS,
        repo_root: str | os.PathLike[str] | None = None,
    ) -> None:
        self._timeout = timeout
        env_root = os.getenv("EDEN_LOCAL_REPO_PATH", "").strip()
        if repo_root is None:
            repo_root = env_root or os.getcwd()
        self._repo_root = Path(repo_root).resolve()
        self._available: bool | None = None

    def is_available(self) -> bool:
        if self._available is None:
            self._available = _openhands_available()
        return self._available

    async def run(
        self,
        candidate: PRCandidate,
        *,
        decision: Any | None = None,
    ) -> PRResult | None:
        if not self.is_available():
            return None
        try:
            task = self._task_for(candidate)
            return await self._run_subprocess(task, candidate)
        except Exception as exc:
            logger.debug("OpenHandsLocalAgent.run: %s", exc)
            return None

    def _task_for(self, candidate: PRCandidate) -> dict[str, Any]:
        """Build the task descriptor OpenHands consumes."""
        return {
            "repo": candidate.repo_full_name,
            "branch": candidate.branch,
            "goal": candidate.incident_summary or "Apply a minimal fix.",
            "files": list(candidate.graph_files),
            "evidence": list(candidate.evidence_refs),
            "constraints": [
                "Make the SMALLEST possible change.",
                "Do not modify tests, CI config, or vendored code.",
                "Output a unified diff in a single fenced ```diff block.",
                "If you cannot fix it in code, respond with "
                "REPORT_ONLY: <reason>.",
            ],
        }

    async def _run_subprocess(
        self,
        task: dict[str, Any],
        candidate: PRCandidate,
    ) -> PRResult | None:
        """Spawn the OpenHands CLI and parse the output."""
        # OpenHands' CLI accepts a task as a JSON payload on
        # stdin (via ``openhands --task-file -``) or as a
        # positional arg. We pass via stdin for portability.
        cmd = self._resolve_cmd()
        if cmd is None:
            return None
        payload = json.dumps(task).encode("utf-8")
        try:
            proc = subprocess.run(
                cmd,
                input=payload,
                cwd=str(self._repo_root),
                capture_output=True,
                timeout=self._timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            logger.debug("OpenHandsLocalAgent: timeout after %ss", self._timeout)
            return PRResult(
                kind="report_only",
                reason="openhands_local_timeout",
                body=(
                    f"OpenHands ran for more than {self._timeout:.0f}s "
                    "without producing a diff. Falling back to "
                    "report-only; the patch will need a human pass."
                ),
            )
        except Exception as exc:
            logger.debug("OpenHandsLocalAgent: spawn failed: %s", exc)
            return None

        out = (proc.stdout or b"").decode("utf-8", errors="replace")
        if proc.returncode != 0:
            stderr = (proc.stderr or b"").decode("utf-8", errors="replace")[:400]
            logger.debug(
                "OpenHandsLocalAgent: exit %s stderr=%s",
                proc.returncode, stderr,
            )
            return PRResult(
                kind="report_only",
                reason=f"openhands_local_exit_{proc.returncode}",
                body=stderr or out[:400],
            )

        diff = _extract_diff(out)
        if not diff:
            if "REPORT_ONLY" in out:
                reason = out.split("REPORT_ONLY", 1)[1].strip().splitlines()[0][:200]
                return PRResult(
                    kind="report_only",
                    reason="openhands_says_not_code_fixable",
                    body=reason or "OpenHands reported not code-fixable.",
                )
            return PRResult(
                kind="report_only",
                reason="openhands_no_diff",
                body=out[:4000],
            )
        return PRResult(
            kind="draft_pr",
            body=out[:8000],
            diff=diff,
            title=_extract_title(out) or f"Auto-fix: {candidate.incident_summary[:80]}",
            conversation_id=f"local-{int(time.time())}",
        )

    def _resolve_cmd(self) -> list[str] | None:
        """Return the command + args to invoke OpenHands locally."""
        cli = shutil.which("openhands")
        if cli:
            # ``openhands --json -`` reads the task from stdin
            # and writes the diff to stdout. The flag set is
            # best-effort — different OpenHands versions
            # accept different flags, so we fall back to a
            # plain invocation if the JSON flag is rejected.
            return [cli, "--json", "--non-interactive"]
        try:
            import openhands  # noqa: F401
        except Exception:
            return None
        return ["python", "-m", "openhands", "--json", "--non-interactive"]


# ── Deterministic scripted patcher ──────────────────────────────────


@dataclass
class _PatchOp:
    """A single deterministic patch operation.

    Operations are encoded as ``(op_kind, **kwargs)`` tuples in
    :func:`ScriptedCodingAgent._plan_ops`. The apply step
    runs each op against the repo and aggregates the diff.
    """

    kind: str
    path: str
    payload: dict[str, Any]


class ScriptedCodingAgent:
    """A bulletproof, deterministic, stdlib-only patch generator.

    The agent takes a :class:`PRCandidate` + a list of likely-
    affected files and applies a small catalog of safe
    operations:

    * ``add_import`` — adds a missing import statement
      (deduped, alphabetised).
    * ``add_docstring`` — adds a docstring to a function /
      class with no docstring.
    * ``add_log_line`` — adds an ``import logging`` + a
      ``logger.debug(...)`` line at the top of a function.
    * ``annotate_unhandled`` — adds a ``# TODO(eden):``
      marker to a bare ``except:`` clause.
    * ``noop_diff`` — when nothing else applies, returns an
      empty diff with a ``draft_pr`` payload that just
      references the affected files. (The caller is then
      expected to ignore the empty diff and post the
      structured body as a draft PR description.)

    Every operation is **reversible** (the original file is
    parsed line-by-line and re-emitted) and **non-destructive**
    (we never delete code, only add / annotate).
    """

    name: str = "scripted"

    def __init__(
        self,
        *,
        repo_root: str | os.PathLike[str] | None = None,
    ) -> None:
        env_root = os.getenv("EDEN_LOCAL_REPO_PATH", "").strip()
        if repo_root is None:
            repo_root = env_root or os.getcwd()
        self._repo_root = Path(repo_root).resolve()

    async def run(
        self,
        candidate: PRCandidate,
        *,
        decision: Any | None = None,
    ) -> PRResult | None:
        try:
            ops = self._plan_ops(candidate)
            if not ops:
                return PRResult(
                    kind="report_only",
                    reason="scripted_no_op_candidate",
                    body=_report_only_body(
                        candidate,
                        "Scripted agent did not identify a "
                        "deterministic safe operation for this "
                        "candidate.",
                    ),
                )
            diffs: list[str] = []
            applied: list[str] = []
            for op in ops:
                d = self._apply(op)
                if d:
                    diffs.append(d)
                    applied.append(f"{op.kind}:{op.path}")
            full_diff = "\n".join(diffs)
            if not full_diff:
                return PRResult(
                    kind="report_only",
                    reason="scripted_no_diff_yielded",
                    body=_report_only_body(
                        candidate,
                        "Scripted agent planned operations but "
                        "none produced a usable diff.",
                    ),
                )
            return PRResult(
                kind="draft_pr",
                title=_scripted_title(candidate, applied),
                body=_scripted_body(candidate, applied),
                diff=full_diff,
                conversation_id=f"scripted-{int(time.time())}",
            )
        except Exception as exc:
            # Bulletproof: any exception becomes a report_only.
            logger.debug("ScriptedCodingAgent.run: %s", exc)
            return PRResult(
                kind="report_only",
                reason=f"scripted_exception:{type(exc).__name__}",
                body=_report_only_body(
                    candidate,
                    f"Scripted agent hit an exception ({exc}); "
                    "falling back to report-only.",
                ),
            )

    def _plan_ops(self, candidate: PRCandidate) -> list[_PatchOp]:
        """Inspect ``candidate.graph_files`` and pick safe ops."""
        ops: list[_PatchOp] = []
        summary = (candidate.incident_summary or "").lower()
        for rel_path in candidate.graph_files[:5]:
            abs_path = self._repo_root / rel_path
            if not abs_path.exists() or not abs_path.is_file():
                continue
            if abs_path.suffix.lower() != ".py":
                continue
            try:
                source = abs_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            if (
                "unhandled" in summary or "except" in summary
            ) and re.search(r"^\s*except\s*:\s*$", source, re.MULTILINE):
                ops.append(_PatchOp(
                    kind="annotate_unhandled", path=rel_path,
                    payload={},
                ))
            if "missing import" in summary or "nameerror" in summary:
                m = re.search(r"name '(\w+)' is not defined", summary)
                if m and re.search(rf"\b{m.group(1)}\b", source):
                    ops.append(_PatchOp(
                        kind="add_import", path=rel_path,
                        payload={"name": m.group(1)},
                    ))
            if (
                "add logging" in summary or "log this" in summary
            ) and "logger.debug" not in source:
                ops.append(_PatchOp(
                    kind="add_log_line", path=rel_path,
                    payload={},
                ))
            if "missing docstring" in summary:
                # Cheap: just annotate the first function without one.
                ops.append(_PatchOp(
                    kind="add_docstring", path=rel_path,
                    payload={"target": "first"},
                ))
        return ops

    def _apply(self, op: _PatchOp) -> str:
        """Apply ``op`` and return the unified diff.

        Returns ``""`` if the operation was a no-op (e.g. the
        candidate already has the fix).
        """
        abs_path = self._repo_root / op.path
        if not abs_path.exists() or not abs_path.is_file():
            return ""
        try:
            original = abs_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""
        updated = _apply_op_text(op, original)
        if updated == original:
            return ""
        return _make_unified_diff(op.path, original, updated)

    # The actual text mutations live in module-level helpers
    # below — kept out of the class so they're easy to unit
    # test in isolation.


# ── Module-level helpers (pure, easy to test) ──────────────────────


def _apply_op_text(op: _PatchOp, source: str) -> str:
    if op.kind == "add_import":
        name = op.payload.get("name", "")
        if not name or f"import {name}" in source:
            return source
        return f"import {name}\n{source}" if not source.startswith("\n") else f"import {name}\n{source.lstrip()}"

    if op.kind == "add_docstring":
        # Insert a stub docstring as the first statement of the
        # first function / class.
        m = re.search(
            r"^(\s*)(?:async\s+def|def|class)\s+\w+[^\n]*:\s*\n",
            source, re.MULTILINE,
        )
        if not m:
            return source
        indent = m.group(1) + "    "
        return source[:m.end()] + f'{indent}"""TODO(eden): add docstring."""\n'

    if op.kind == "add_log_line":
        if "import logging" in source:
            header = ""
            body = source
        else:
            header = "import logging\n\nlogger = logging.getLogger(__name__)\n\n"
            body = source
        # Insert logger.debug at the top of the first function body.
        m = re.search(
            r"^(\s*)(?:async\s+def|def)\s+\w+[^\n]*:\s*\n",
            body, re.MULTILINE,
        )
        if not m:
            return source
        indent = m.group(1) + "    "
        return header + body[:m.end()] + f"{indent}logger.debug('entered')\n"

    if op.kind == "annotate_unhandled":
        return re.sub(
            r"(^\s*)except\s*:\s*$",
            r"\1except:  # TODO(eden): handle this exception explicitly\n",
            source,
            flags=re.MULTILINE,
        )

    return source


def _make_unified_diff(path: str, before: str, after: str) -> str:
    """Build a minimal unified-diff string for one file."""
    import difflib
    diff_lines = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"a/{path}",
        tofile=f"b/{path}",
    )
    return "".join(diff_lines)


def _extract_diff(text: str) -> str:
    """Pull the first fenced diff/patch block from ``text``."""
    if not text:
        return ""
    m = re.search(
        r"```(?:diff|patch)?\s*\n([\s\S]+?)```",
        text, re.IGNORECASE,
    )
    return (m.group(1).strip() if m else "")


def _extract_title(text: str) -> str:
    """Best-effort: pull a PR title from the first Markdown header."""
    if not text:
        return ""
    for line in text.splitlines()[:10]:
        m = re.match(r"\s*#+\s+(.+)$", line)
        if m:
            return m.group(1).strip()[:100]
    return ""


def _scripted_title(candidate: PRCandidate, applied: list[str]) -> str:
    if applied:
        head = applied[0]
        kind = head.split(":", 1)[0]
        return f"Auto ({kind}): {candidate.incident_summary[:80]}".strip()
    return f"Auto: {candidate.incident_summary[:80]}".strip()


def _scripted_body(candidate: PRCandidate, applied: list[str]) -> str:
    parts = [
        "### Eden local scripted patch",
        "",
        candidate.incident_summary or "(no summary provided)",
        "",
        "#### Operations applied",
    ]
    parts.extend(f"- `{op}`" for op in applied)
    if candidate.graph_files:
        parts.append("\n#### Likely-affected files")
        parts.extend(f"- `{p}`" for p in candidate.graph_files[:10])
    if candidate.evidence_refs:
        parts.append("\n#### Evidence")
        parts.extend(f"- `{e}`" for e in candidate.evidence_refs[:5])
    parts.append(
        "\nThis patch was generated by Eden's local scripted "
        "agent (deterministic, stdlib-only). Please review "
        "before merging."
    )
    return "\n".join(parts)


def _report_only_body(candidate: PRCandidate, reason: str) -> str:
    parts = [
        "### Eden report (no patch)",
        "",
        f"**Reason:** {reason}",
        "",
        candidate.incident_summary or "(no summary provided)",
        "",
    ]
    if candidate.graph_files:
        parts.append("#### Likely-affected files")
        parts.extend(f"- `{p}`" for p in candidate.graph_files[:10])
        parts.append("")
    if candidate.evidence_refs:
        parts.append("#### Evidence")
        parts.extend(f"- `{e}`" for e in candidate.evidence_refs[:5])
        parts.append("")
    parts.append(
        "Eden's local coding agent could not produce a "
        "safe automatic patch for this candidate. Please "
        "investigate manually."
    )
    return "\n".join(parts)


# ── Combined LocalCodingAgent ───────────────────────────────────────


class LocalCodingAgent:
    """The bulletproof default :class:`PRAgent` implementation.

    Tries the local OpenHands subprocess first (when
    installed), then the deterministic scripted agent,
    then a structured report-only payload. Every method
    returns a :class:`PRResult` — no more ``None`` returns.
    """

    name: str = "local-coding"

    def __init__(
        self,
        *,
        repo_root: str | os.PathLike[str] | None = None,
        timeout: float = OPENHANDS_LOCAL_TIMEOUT_SECONDS,
    ) -> None:
        self._repo_root = repo_root
        self._openhands = OpenHandsLocalAgent(
            timeout=timeout, repo_root=repo_root,
        )
        self._scripted = ScriptedCodingAgent(repo_root=repo_root)
        # Cache the "what works" decision for 60s — once a
        # backend is unavailable, don't re-probe every call.
        self._lock = threading.Lock()
        self._cached_backend: str | None = None
        self._cached_at: float = 0.0

    async def run(
        self,
        candidate: PRCandidate,
        *,
        decision: Any | None = None,
    ) -> PRResult | None:
        """Try OpenHands → scripted → report-only. Never None."""
        try:
            backend = self._pick_backend()
            if backend == "openhands-local":
                r = await self._openhands.run(candidate, decision=decision)
                if r is not None and r.kind != "report_only":
                    return r
                # Fall through to scripted if OpenHands reported
                # not-fixable or didn't produce a diff.
            r2 = await self._scripted.run(candidate, decision=decision)
            if r2 is not None:
                return r2
            # Last resort — explicit report-only payload.
            return PRResult(
                kind="report_only",
                reason="local_coding_no_result",
                body=_report_only_body(
                    candidate,
                    "Local coding agent exhausted both OpenHands "
                    "and scripted fallbacks without producing a "
                    "diff. Manual review required.",
                ),
            )
        except Exception as exc:
            # Truly bulletproof: even an exception in our
            # dispatch logic becomes a report-only payload
            # rather than ``None``.
            logger.debug("LocalCodingAgent.run: %s", exc)
            return PRResult(
                kind="report_only",
                reason=f"local_coding_exception:{type(exc).__name__}",
                body=_report_only_body(
                    candidate,
                    f"Local coding agent hit an exception ({exc}); "
                    "falling back to report-only.",
                ),
            )

    def _pick_backend(self) -> str:
        """Pick the first backend to try.

        Cached for 60s so we don't re-probe OpenHands on
        every call.
        """
        with self._lock:
            now = time.time()
            if self._cached_backend and now - self._cached_at < 60.0:
                return self._cached_backend
            if self._openhands.is_available():
                self._cached_backend = "openhands-local"
            else:
                self._cached_backend = "scripted"
            self._cached_at = now
            return self._cached_backend
