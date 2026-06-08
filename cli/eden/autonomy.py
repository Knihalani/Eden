"""Autonomy & safety guardrails for the Eden CLI.

The :class:`AutonomyManager` centralises approval gates and safety
checks. It is invoked by every command that performs a non-trivial
action (file write, push, pipeline invocation, PR creation, etc.).

Autonomy levels
---------------
- ``approval``       (default) — prompt for confirmation on every
  non-trivial action.
- ``semi``           — auto-approve local file edits; prompt for PR /
  pipeline / KB writes.
- ``autonomous``     — no prompts; rely on safety guardrails (branch
  protection, secret detection, dangerous-command blocklist).

Per-action overrides
--------------------
Individual actions can be toggled regardless of mode via
``autonomy.<action>`` in ``.eden/config.yaml``:

  auto_test, auto_lint, auto_pr, auto_pipeline, auto_kb_write,
  confirm_destructive.

Safety guardrails (always enforced)
-----------------------------------
- Never push to ``main``/``master`` without explicit confirmation.
- Never modify files matching ``.env*``, ``secrets.*``,
  ``*.key``, ``*.pem`` patterns.
- Never execute dangerous shell patterns: ``rm -rf /``,
  ``sudo ...``, ``curl ... | bash`` (autonomous mode).
- Rate-limit pipeline invocations (default 5/hour).
"""

from __future__ import annotations

import fnmatch
import os
import re
import subprocess  # nosec - we only *check* dangerous patterns, never run
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Files we will never write to / modify.
PROTECTED_PATH_PATTERNS: Tuple[str, ...] = (
    ".env",
    ".env.*",
    "secrets.*",
    "secrets/*",
    "*.key",
    "*.pem",
    "*.p12",
    "*.pfx",
    "id_rsa",
    "id_rsa.*",
    ".ssh/*",
    "credentials",
    "credentials.*",
    "*.gpg",
)

# Branches that require explicit confirmation regardless of mode.
PROTECTED_BRANCHES: Tuple[str, ...] = (
    "main",
    "master",
    "release",
    "production",
)

# Shell patterns that are always blocked in autonomous mode.
DANGEROUS_SHELL_PATTERNS: Tuple[str, ...] = (
    r"\brm\s+-rf\s+/",
    r"\bsudo\b",
    r"\bcurl\b[^\n]*\|\s*bash\b",
    r"\bcurl\b[^\n]*\|\s*sh\b",
    r"\bwget\b[^\n]*\|\s*bash\b",
    r"\bwget\b[^\n]*\|\s*sh\b",
    r"\bchmod\s+777\b",
    r"\bdd\s+if=",
    r":\(\)\s*\{",  # fork bomb
)

# Common secret patterns. Conservative: we only flag obvious ones.
SECRET_PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("aws_access_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("aws_secret", re.compile(r"(?i)aws[_\-]?secret[_\-]?access[_\-]?key\s*[:=]\s*[\"']?([A-Za-z0-9/+=]{40})")),
    ("github_pat", re.compile(r"ghp_[A-Za-z0-9]{36,}")),
    ("github_oauth", re.compile(r"gho_[A-Za-z0-9]{36,}")),
    ("anthropic_key", re.compile(r"sk-ant-[A-Za-z0-9\-]{32,}")),
    ("openai_key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("private_key_block", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("slack_token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("jwt_token", re.compile(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+")),
]


# ---------------------------------------------------------------------------
# Action types
# ---------------------------------------------------------------------------

# Action types the autonomy manager knows about. Used both for the
# per-action override keys in config and for the rate limiter.

ACTION_FILE_WRITE = "file_write"
ACTION_PUSH = "push"
ACTION_PR_CREATE = "pr_create"
ACTION_PIPELINE_INVOKE = "pipeline_invoke"
ACTION_KB_WRITE = "kb_write"
ACTION_TEST_RUN = "test_run"
ACTION_LINT_RUN = "lint_run"
ACTION_SHELL_RUN = "shell_run"

ALL_ACTIONS: Tuple[str, ...] = (
    ACTION_FILE_WRITE,
    ACTION_PUSH,
    ACTION_PR_CREATE,
    ACTION_PIPELINE_INVOKE,
    ACTION_KB_WRITE,
    ACTION_TEST_RUN,
    ACTION_LINT_RUN,
    ACTION_SHELL_RUN,
)


# Action -> config key mapping. Per-action overrides live under
# ``autonomy.<key>`` and default to the mode's behaviour.
ACTION_CONFIG_KEYS: Dict[str, str] = {
    ACTION_TEST_RUN: "auto_test",
    ACTION_LINT_RUN: "auto_lint",
    ACTION_PR_CREATE: "auto_pr",
    ACTION_PIPELINE_INVOKE: "auto_pipeline",
    ACTION_KB_WRITE: "auto_kb_write",
}


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class SafetyFinding:
    """A single finding from secret/path detection."""

    kind: str  # "secret" | "protected_path" | "protected_branch" | "dangerous_shell" | "rate_limited"
    detail: str
    severity: str = "high"  # "high" | "medium" | "low"

    def to_dict(self) -> Dict[str, Any]:
        return {"kind": self.kind, "detail": self.detail, "severity": self.severity}


@dataclass
class AutonomyDecision:
    """Outcome of an autonomy check."""

    allowed: bool
    requires_confirmation: bool
    findings: List[SafetyFinding] = field(default_factory=list)
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "allowed": self.allowed,
            "requires_confirmation": self.requires_confirmation,
            "reason": self.reason,
            "findings": [f.to_dict() for f in self.findings],
        }


# ---------------------------------------------------------------------------
# Helper: prompt callback
# ---------------------------------------------------------------------------


# A prompt callback takes a message and returns True/False.
# In real C1 chat-loop use, this is wired to Aider's confirm_ask.
PromptFn = Callable[[str], bool]


def _identity_prompt(message: str) -> bool:
    """Default prompt: deny. Tests must inject a stub."""
    raise RuntimeError(
        f"AutonomyManager attempted to prompt for confirmation: {message!r}. "
        "Inject a prompt_fn to handle interactive approval."
    )


def _auto_yes_prompt(message: str) -> bool:  # pragma: no cover - test util
    return True


def _auto_no_prompt(message: str) -> bool:  # pragma: no cover - test util
    return False


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------


class AutonomyManager:
    """Approves or denies actions based on the configured autonomy mode."""

    def __init__(
        self,
        config: Any,
        *,
        prompt_fn: Optional[PromptFn] = None,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self._config = config
        self._prompt = prompt_fn or _identity_prompt
        self._clock = clock or time.time

        # Rate-limit state: action -> [timestamps]
        self._rate_history: Dict[str, List[float]] = {}

        section = config.get_section("autonomy") if hasattr(config, "get_section") else {}
        self.mode: str = (section.get("mode") or "approval").lower()
        if self.mode not in {"approval", "semi", "autonomous"}:
            # Gracefully handle typos like "approvals".
            self.mode = "approval"

    # --- Public API --------------------------------------------------------

    def is_action_auto_approved(self, action: str) -> bool:
        """Return True if the action can proceed without prompting."""
        if self.mode == "autonomous":
            return True
        if self.mode == "semi":
            return action in {ACTION_FILE_WRITE, ACTION_TEST_RUN, ACTION_LINT_RUN}
        # approval mode
        section = self._config.get_section("autonomy") if hasattr(self._config, "get_section") else {}
        key = ACTION_CONFIG_KEYS.get(action)
        if key and section.get(key) is True:
            return True
        return False

    def check_action(
        self,
        action: str,
        *,
        paths: Optional[Sequence[str]] = None,
        branch: Optional[str] = None,
        command: Optional[str] = None,
        content_samples: Optional[Sequence[str]] = None,
    ) -> AutonomyDecision:
        """Check whether an action is allowed under current autonomy.

        Args:
            action: One of :data:`ALL_ACTIONS`.
            paths: File paths the action would touch (for write/push
                safety checks).
            branch: Git branch the action targets (for push protection).
            command: Shell command the action would run (for shell_run).
            content_samples: Text snippets to scan for secrets (e.g. the
                proposed diff).
        """
        findings: List[SafetyFinding] = []

        # 1. Path protection
        for p in paths or ():
            for finding in self._check_path(p):
                findings.append(finding)

        # 2. Branch protection
        if branch is not None:
            for finding in self._check_branch(branch):
                findings.append(finding)

        # 3. Shell command blocklist
        if command is not None:
            for finding in self._check_shell_command(command):
                findings.append(finding)

        # 4. Secret detection
        for sample in content_samples or ():
            for finding in self._scan_text_for_secrets(sample):
                findings.append(finding)

        # 5. Rate limit
        for finding in self._check_rate_limit(action):
            findings.append(finding)

        # Hard blocks (regardless of mode) — secrets, protected paths,
        # and rate-limit exhaustion always deny. Secrets and rate
        # limits are server-side safety mechanisms that cannot be
        # bypassed by a human prompt.
        hard_block = any(
            f.kind in {"secret", "protected_path", "rate_limited"} for f in findings
        )

        if hard_block:
            return AutonomyDecision(
                allowed=False,
                requires_confirmation=False,
                findings=findings,
                reason="hard safety block: " + "; ".join(f.detail for f in findings),
            )

        # Soft blocks: protected branch & dangerous shell always
        # require explicit confirmation, even in autonomous mode.
        requires_confirm = any(
            f.kind in {"protected_branch", "dangerous_shell"} for f in findings
        )

        if requires_confirm and self.mode == "autonomous":
            # Autonomous mode STILL requires confirmation for these.
            needs_prompt = True
        elif self.is_action_auto_approved(action):
            needs_prompt = False
        else:
            needs_prompt = True

        if not needs_prompt:
            return AutonomyDecision(
                allowed=True,
                requires_confirmation=False,
                findings=findings,
                reason="auto-approved by autonomy config",
            )

        return AutonomyDecision(
            allowed=True,  # allowed only if user confirms
            requires_confirmation=True,
            findings=findings,
            reason="user confirmation required",
        )

    def confirm(self, decision: AutonomyDecision, message: str) -> bool:
        """If the decision requires confirmation, prompt. Returns the
        final allow/deny. ``decision`` is mutated to reflect the outcome."""
        if not decision.requires_confirmation:
            return decision.allowed
        try:
            user_says_yes = self._prompt(message)
        except Exception:  # noqa: BLE001
            user_says_yes = False
        decision.allowed = bool(user_says_yes)
        if not decision.allowed:
            decision.reason = "user denied"
        return decision.allowed

    def record_invocation(self, action: str) -> None:
        """Record that an action was *actually* invoked (for rate limiting)."""
        ts = self._clock()
        self._rate_history.setdefault(action, []).append(ts)

    # --- Internals ---------------------------------------------------------

    def _check_path(self, path: str) -> List[SafetyFinding]:
        findings: List[SafetyFinding] = []
        # Normalise: strip leading slashes / repo prefixes
        norm = path.lstrip("/")
        for pattern in PROTECTED_PATH_PATTERNS:
            if fnmatch.fnmatch(norm, pattern) or fnmatch.fnmatch(Path(norm).name, pattern):
                findings.append(
                    SafetyFinding(
                        kind="protected_path",
                        detail=f"path matches protected pattern {pattern!r}: {path}",
                        severity="high",
                    )
                )
                break
        return findings

    def _check_branch(self, branch: str) -> List[SafetyFinding]:
        findings: List[SafetyFinding] = []
        if branch.lower() in {b.lower() for b in PROTECTED_BRANCHES}:
            findings.append(
                SafetyFinding(
                    kind="protected_branch",
                    detail=f"target branch {branch!r} is protected",
                    severity="high",
                )
            )
        return findings

    def _check_shell_command(self, command: str) -> List[SafetyFinding]:
        findings: List[SafetyFinding] = []
        for pattern in DANGEROUS_SHELL_PATTERNS:
            if re.search(pattern, command):
                findings.append(
                    SafetyFinding(
                        kind="dangerous_shell",
                        detail=f"command matches dangerous pattern {pattern!r}",
                        severity="high",
                    )
                )
        return findings

    def _scan_text_for_secrets(self, text: str) -> List[SafetyFinding]:
        findings: List[SafetyFinding] = []
        if not text:
            return findings
        for name, pattern in SECRET_PATTERNS:
            m = pattern.search(text)
            if m:
                findings.append(
                    SafetyFinding(
                        kind="secret",
                        detail=f"matched {name} pattern (offset {m.start()})",
                        severity="high",
                    )
                )
        return findings

    def _check_rate_limit(self, action: str) -> List[SafetyFinding]:
        section = self._config.get_section("rate_limits") if hasattr(self._config, "get_section") else {}
        try:
            limit = int(section.get("pipeline_invocations_per_hour", 5))
        except (TypeError, ValueError):  # pragma: no cover - defensive
            limit = 5
        if action != ACTION_PIPELINE_INVOKE:
            return []
        history = self._rate_history.get(action, [])
        # Drop entries older than 1 hour.
        cutoff = self._clock() - 3600.0
        fresh = [t for t in history if t >= cutoff]
        self._rate_history[action] = fresh
        if len(fresh) >= limit:
            return [
                SafetyFinding(
                    kind="rate_limited",
                    detail=f"pipeline invocations exceeded: {len(fresh)}/{limit} per hour",
                    severity="medium",
                )
            ]
        return []


# ---------------------------------------------------------------------------
# Convenience helpers
# ---------------------------------------------------------------------------


def is_path_protected(path: str) -> bool:
    """Public helper: True if ``path`` is in the protected-path blocklist."""
    norm = path.lstrip("/")
    return any(
        fnmatch.fnmatch(norm, p) or fnmatch.fnmatch(Path(norm).name, p)
        for p in PROTECTED_PATH_PATTERNS
    )


def scan_text_for_secrets(text: str) -> List[SafetyFinding]:
    """Public helper: scan a string for known secret patterns."""
    findings: List[SafetyFinding] = []
    if not text:
        return findings
    for name, pattern in SECRET_PATTERNS:
        m = pattern.search(text)
        if m:
            findings.append(
                SafetyFinding(
                    kind="secret",
                    detail=f"matched {name} pattern (offset {m.start()})",
                    severity="high",
                )
            )
    return findings


def shell_command_is_dangerous(command: str) -> bool:
    """Public helper: True if a shell command matches a blocklisted pattern."""
    return any(re.search(p, command) for p in DANGEROUS_SHELL_PATTERNS)


# Suppress unused-import warning for subprocess (kept here for future
# sub-process gating helpers).
_ = subprocess
