"""EdenPatchAgent — real patch generation via Eden's ModelRouter + PatchGenerator.

This is the production-default PR agent. It does NOT
require a hosted OpenHands key — it uses Eden's existing
:class:`eden.code_change.patch_generator.PatchGenerator`
which calls real LLMs through
:class:`eden.optimization.model_router.ModelRouter`.

The agent is:

* **Local** — runs in-process. No external HTTP calls
  beyond the configured LLM provider (OpenRouter /
  Anthropic / etc).
* **Real** — produces actual unified diffs via the LLM
  pipeline, with the critic loop + size cap + similarity
  dedup + quality floor that the existing
  ``PatchGenerator`` already implements.
* **Bounded** — every call is wrapped in
  ``asyncio.wait_for`` with a configurable timeout so a
  stuck LLM can't block the discipline layer.
* **Cost-effective** — reuses the same ModelRouter tier
  selection (T2 for code generation, per the v1.6
  ship plan). Cost is reported back in the result so
  callers can rate-limit against it.

When the underlying LLM call fails (network, model
overloaded, validation rejected), the result is a
structured ``report_only`` payload — the agent never
fabricates a diff. The discipline layer's confidence
gate is the only protection against ungrounded PRs, and
an ungrounded agent output would bypass it.

The agent is invoked ONLY after the discipline layer's
confidence gate has cleared (the incident + scheduled
triggers handle that). The agent's job is to produce
the smallest high-confidence patch that addresses the
issue described by the candidate + the graph context.

Failure modes:

* ``ModelRouter()`` raises → ``report_only`` (reason
  ``router_unavailable``).
* ``PatchGenerator.generate`` returns the
  ``not_implemented`` envelope → ``report_only``
  (reason ``gate_4a_blocked``).
* The diff doesn't validate as a unified diff → reject.
* The LLM cost exceeds the per-call cap (default $0.50)
  → reject.
* Any exception in the inner call → ``report_only``
  with a debug reason.

The agent never raises — every failure mode returns a
structured :class:`PRResult` so the discipline layer's
chokepoint sees a uniform return type.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .openhands import PRCandidate, PRResult, _extract_diff

logger = logging.getLogger(__name__)


# Defaults overridable per-org via the discipline policy JSONB.
DEFAULT_EDEN_AGENT_POLICY: dict[str, Any] = {
    "max_call_cost_usd": 0.50,         # hard cap per call
    "timeout_seconds": 120.0,          # wall-time cap
    "min_diff_lines": 1,               # a no-op diff is not a fix
    "max_diff_lines": 500,             # hard cap per brief
}


_DIFF_HEADER_RE = None  # lazy import to avoid circular


def _looks_like_diff(text: str) -> bool:
    """A diff must have at least one ``+++`` file header and one hunk."""
    if not text:
        return False
    return (
        "+++" in text
        and "@@" in text
    )


class EdenPatchAgent:
    """The real PR agent — uses Eden's PatchGenerator + ModelRouter.

    This is the production default. It runs locally
    (no external HTTP beyond the LLM provider the
    operator has already configured) and produces real
    unified diffs.
    """

    name: str = "eden_patch"

    def __init__(self, *, policy: dict[str, Any] | None = None) -> None:
        self._policy = {**DEFAULT_EDEN_AGENT_POLICY, **(policy or {})}
        self._cost_used_usd = 0.0
        self._cost_lock = asyncio.Lock()

    @property
    def policy(self) -> dict[str, Any]:
        return dict(self._policy)

    @property
    def cost_used_usd(self) -> float:
        return self._cost_used_usd

    async def run(
        self,
        candidate: PRCandidate,
        *,
        decision: Any | None = None,
    ) -> PRResult | None:
        """Generate a real patch via Eden's PatchGenerator.

        Returns a :class:`PRResult`. Never raises.
        ``None`` only on catastrophic internal failure
        (should not happen — every path returns a
        structured result).
        """
        # Lazy imports keep import-time cost low and avoid
        # pulling ModelRouter unless the agent actually runs.
        try:
            from eden.code_change._common import _new_id
            from eden.code_change.patch_generator import PatchGenerator
        except Exception as exc:
            logger.debug("EdenPatchAgent: import failed: %s", exc)
            return PRResult(
                kind="report_only",
                reason="agent_import_failed",
                body=(
                    f"Eden's patch generator could not be imported: "
                    f"{exc}. The discipline layer will surface this "
                    "as a report."
                ),
            )

        if not candidate.repo_full_name:
            return PRResult(
                kind="report_only",
                reason="missing_repo_full_name",
                body="No linked repository — Eden cannot generate a patch.",
            )

        if not candidate.org_id:
            return PRResult(
                kind="report_only",
                reason="missing_org_id",
                body="No org context — cannot attribute the generated patch.",
            )

        # Build the PatchGenerator invocation. The graph-derived
        # file paths become ``linked_files`` so the generator can
        # pull the relevant source context.
        linked_files: list[dict[str, str]] = []
        for path in candidate.graph_files[:10]:
            linked_files.append({"path": path, "content": ""})

        # Build a stable trace id from the candidate's fingerprint
        # so retries + the audit trail line up.
        rca_id = candidate.candidate_id or _new_id("rca")
        trace_id = candidate.candidate_id or _new_id("trace")
        repo_id = candidate.repo_id or candidate.repo_full_name

        try:
            gen = PatchGenerator()
        except Exception as exc:
            logger.debug("EdenPatchAgent: PatchGenerator init failed: %s", exc)
            return PRResult(
                kind="report_only",
                reason="patch_generator_init_failed",
                body=(
                    f"PatchGenerator could not be initialised: {exc}. "
                    "Check that the ModelRouter is configured "
                    "(OPENROUTER_API_KEY / OPENAI_API_KEY / "
                    "ANTHROPIC_API_KEY)."
                ),
            )

        try:
            async def _call() -> dict[str, Any]:
                return await gen.generate(
                    org_id=candidate.org_id,
                    rca_id=rca_id,
                    trace_id=trace_id,
                    repo_id=repo_id,
                    linked_files=linked_files,
                    test_plan=[],
                    rca_summary=candidate.incident_summary,
                )

            envelope = await asyncio.wait_for(
                _call(),
                timeout=float(self._policy["timeout_seconds"]),
            )
        except TimeoutError:
            logger.debug(
                "EdenPatchAgent: timeout after %ss",
                self._policy["timeout_seconds"],
            )
            return PRResult(
                kind="report_only",
                reason="agent_timeout",
                body=(
                    f"Eden's patch generator did not finish within "
                    f"{self._policy['timeout_seconds']}s. The "
                    "discipline layer should retry later."
                ),
            )
        except Exception as exc:
            logger.debug("EdenPatchAgent: generate failed: %s", exc)
            return PRResult(
                kind="report_only",
                reason="agent_exception",
                body=f"Patch generation raised: {exc}",
            )

        # Inspect the envelope. PatchGenerator returns the standard
        # Cat 23 envelope; success is ``status="ok"`` with a ``diff``
        # in ``data``.
        status = str(envelope.get("status") or "")
        if status == "not_implemented":
            # The patch generator hit its Gate-4a block (LLM call
            # failed, model unavailable, etc). Surface the gate
            # reason from the envelope.
            gate = envelope.get("data", {}).get("gate") or "gate_blocked"
            return PRResult(
                kind="report_only",
                reason=f"patch_gen_{gate}",
                body=envelope.get("message") or str(envelope),
            )
        if status == "error":
            err = envelope.get("error_code") or "patch_gen_error"
            return PRResult(
                kind="report_only",
                reason=f"patch_gen_{err}",
                body=envelope.get("message") or str(envelope),
            )
        if status != "ok":
            return PRResult(
                kind="report_only",
                reason="patch_gen_unknown_status",
                body=str(envelope),
            )

        # OK envelope — pull the diff + cost + quality score.
        data = envelope.get("data") or {}
        diff = (
            data.get("diff")
            or data.get("generated_diff")
            or data.get("unified_diff")
            or ""
        )
        if isinstance(diff, str) and diff and not _looks_like_diff(diff):
            # Some envelopes carry the diff in another field; try
            # to extract from the body / explanation.
            for candidate_field in ("body", "explanation", "patch"):
                value = data.get(candidate_field)
                if isinstance(value, str) and _looks_like_diff(value):
                    diff = _extract_diff(value) or value
                    break

        if not diff or not _looks_like_diff(diff):
            return PRResult(
                kind="report_only",
                reason="patch_gen_no_diff",
                body=(
                    "Eden's patch generator returned no unified diff. "
                    "This usually means the LLM call succeeded but "
                    "the output didn't parse as a patch."
                ),
            )

        # Cost cap. PatchGenerator reports cost_usd in the envelope.
        cost_usd = float(data.get("cost_usd") or 0.0)
        max_cost = float(self._policy["max_call_cost_usd"])
        if cost_usd > max_cost:
            return PRResult(
                kind="report_only",
                reason="patch_gen_cost_above_cap",
                body=(
                    f"Patch generation cost ${cost_usd:.3f} exceeds "
                    f"the per-call cap of ${max_cost:.2f}. "
                    "Operator should review the prompt or raise the cap."
                ),
            )
        async with self._cost_lock:
            self._cost_used_usd += cost_usd

        # Size cap. Defensive — PatchGenerator already enforces this.
        diff_line_count = diff.count("\n+") + diff.count("\n-")
        if diff_line_count > int(self._policy["max_diff_lines"]):
            return PRResult(
                kind="report_only",
                reason="patch_gen_diff_too_large",
                body=(
                    f"Patch has {diff_line_count} lines, above the "
                    f"{self._policy['max_diff_lines']} cap."
                ),
            )
        if diff_line_count < int(self._policy["min_diff_lines"]):
            return PRResult(
                kind="report_only",
                reason="patch_gen_diff_too_small",
                body="Patch is effectively a no-op; not worth opening as a PR.",
            )

        # Build the body — the existing PatchGenerator returns the
        # body via data.explanation or data.body. Fall back to a
        # structured summary if neither is set.
        body = (
            data.get("body")
            or data.get("explanation")
            or data.get("description")
            or _summary_from_diff(diff, candidate)
        )
        title = (
            data.get("title")
            or data.get("pr_title")
            or _default_title(candidate)
        )
        # quality_score from PatchGenerator → kind promotion.
        quality = float(data.get("quality_score") or 0.0)
        # Default to draft; promote to pr_ready when the quality
        # is high AND the discipline decision is allowed AND the
        # caller hasn't explicitly asked for draft.
        kind = "draft_pr"
        if (
            quality >= 0.85
            and decision is not None
            and getattr(decision, "allowed", False)
            and decision.score >= 0.85
        ):
            kind = "pr_ready"

        return PRResult(
            kind=kind,
            title=str(title),
            body=str(body),
            diff=str(diff),
            conversation_id=str(data.get("patch_id") or ""),
            raw={
                "agent": "eden_patch",
                "quality_score": quality,
                "cost_usd": cost_usd,
                "model_used": data.get("model_used") or "",
                "patch_id": data.get("patch_id") or "",
            },
        )


def _default_title(candidate: PRCandidate) -> str:
    """Fallback PR title."""
    summary = candidate.incident_summary.strip()
    if not summary:
        return "[Eden Agent] Fix"
    # Cap at 72 chars; conventional commit style.
    if len(summary) > 72:
        summary = summary[:69] + "..."
    return f"[Eden Agent] {summary}"


def _summary_from_diff(diff: str, candidate: PRCandidate) -> str:
    """Fallback PR body — derived from the diff + the candidate."""
    files: list[str] = []
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            files.append(line[len("+++ b/"):].strip())
    files = sorted(set(files))
    parts: list[str] = [
        "## Eden Agent — automated fix",
        "",
        candidate.incident_summary or "(no summary)",
        "",
    ]
    if candidate.graph_files:
        parts.append("### Likely-affected files (from repo graph)")
        parts.extend(f"- `{p}`" for p in candidate.graph_files[:10])
        parts.append("")
    if files:
        parts.append("### Files changed")
        parts.extend(f"- `{p}`" for p in files)
        parts.append("")
    if candidate.evidence_refs:
        parts.append("### Evidence")
        parts.extend(f"- `{e}`" for e in candidate.evidence_refs[:10])
        parts.append("")
    parts.append("### Diff")
    parts.append("```diff")
    parts.append(diff.strip())
    parts.append("```")
    return "\n".join(parts)
