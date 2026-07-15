"""Cat 23 Gate 3 sandbox substitute.

Provides an isolated subprocess runner for patch test
execution. Full Firecracker microVM isolation is a future
enhancement — this package ships wall-clock timeout +
allowlisted commands + path-traversal rejection as the
practical substitute.
"""

from .runner import (
    ALLOWED_COMMAND_PREFIXES,
    SandboxResult,
    SandboxRunner,
    apply_patch_files,
    run_in_sandbox,
)

__all__ = [
    "ALLOWED_COMMAND_PREFIXES",
    "SandboxResult",
    "SandboxRunner",
    "apply_patch_files",
    "run_in_sandbox",
]
