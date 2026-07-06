"""OpenHands PR-agent implementation.

Talks to the OpenHands Cloud API:
https://www.openhands.dev/blog/programmatically-access-coding-agents-with-the-openhands-cloud-api

The endpoints we use:

* ``POST /api/v1/conversations`` — start a coding task
  with a structured prompt.
* ``GET /api/v1/conversations/{id}`` — poll for status.

Auth: ``Authorization: Bearer <OPENHANDS_API_KEY>``.

The agent is invoked ONLY after the discipline layer's
confidence gate has cleared. The agent's job is to
produce the smallest high-confidence patch that fixes
the issue described by the candidate + the graph
context. The agent does NOT make the discipline
decision — that's the gate's job.

Failure modes: every method degrades to ``None`` on a
non-2xx response, an httpx timeout, or a missing key.
The caller (the trigger flow) treats ``None`` as
"agent unavailable, report-only".

Activation: requires ``OPENHANDS_API_KEY``. When the
key is missing, the factory falls back to
:class:`LocalPRAgent`.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger(__name__)


OPENHANDS_BASE_URL = os.getenv(
    "OPENHANDS_BASE_URL", "https://app.openhands.dev/api",
)
OPENHANDS_TIMEOUT_SECONDS = float(
    os.getenv("OPENHANDS_TIMEOUT_SECONDS", "60"),
)
# How long we'll wait for the agent to finish before
# giving up. OpenHands runs can take 1-5 minutes for
# non-trivial patches; we cap at 5 minutes here so a
# stuck agent doesn't block the discipline layer.
OPENHANDS_MAX_WAIT_SECONDS = float(
    os.getenv("OPENHANDS_MAX_WAIT_SECONDS", "300"),
)


@dataclass
class PRCandidate:
    """The bundle the agent receives.

    Attributes:
        repo_full_name: The linked repo (``owner/name``).
        branch: The branch to base the patch on.
        incident_summary: A short, natural-language
            description of the issue.
        candidate_id: The discipline-layer identifier
            (fingerprint or cluster id).
        graph_files: Files surfaced by the repo graph
            as likely affected.
        graph_snippets: ``(path, excerpt)`` snippets
            from the repo graph.
        evidence_refs: Trace ids / RCA ids / telemetry
            signatures that back the candidate.
        target_kind: ``"incident"`` or ``"scheduled"``.
        repo_id: The Eden-internal repo id.
        org_id: The org id (for audit logging).
    """

    repo_full_name: str
    branch: str = "main"
    incident_summary: str = ""
    candidate_id: str = ""
    graph_files: tuple[str, ...] = field(default_factory=tuple)
    graph_snippets: tuple[tuple[str, str], ...] = field(default_factory=tuple)
    evidence_refs: tuple[str, ...] = field(default_factory=tuple)
    target_kind: str = "incident"
    repo_id: str = ""
    org_id: str = ""


@dataclass
class PRResult:
    """The structured output from :meth:`OpenHandsPRAgent.run`.

    Attributes:
        kind: ``"pr_ready"``, ``"draft_pr"``, or
            ``"report_only"``.
        title: PR title.
        body: PR body / description.
        diff: The unified diff (may be empty for
            ``report_only``).
        reason: Human-readable reason (only set when
            ``kind="report_only"``).
        conversation_id: OpenHands's conversation id
            (for traceability).
        raw: The raw provider payload.
    """

    kind: str = "report_only"
    title: str = ""
    body: str = ""
    diff: str = ""
    reason: str = ""
    conversation_id: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


_DIFF_RE = re.compile(
    r"```(?:diff|patch)?\s*\n([\s\S]+?)```",
    re.IGNORECASE,
)


def _extract_diff(text: str) -> str:
    """Extract the first fenced diff/patch block from the assistant text."""
    if not text:
        return ""
    m = _DIFF_RE.search(text)
    return (m.group(1).strip() if m else "")


def _prompt_for(candidate: PRCandidate) -> str:
    """Build the structured prompt sent to the OpenHands agent."""
    parts: list[str] = [
        "You are Eden's PR agent. Make the SMALLEST high-"
        "confidence change that addresses the following "
        "incident. Open a draft PR by default. If the "
        "issue is not code-fixable, say so explicitly.\n",
    ]
    parts.append(f"Repository: {candidate.repo_full_name}")
    parts.append(f"Base branch: {candidate.branch}")
    if candidate.incident_summary:
        parts.append(f"\nIncident summary:\n{candidate.incident_summary}\n")
    if candidate.evidence_refs:
        parts.append(
            "Evidence: " + ", ".join(candidate.evidence_refs) + "\n",
        )
    if candidate.graph_files:
        parts.append(
            "Likely-affected files (from repo graph):\n"
            + "\n".join(f"- {p}" for p in candidate.graph_files[:20])
        )
    for path, excerpt in candidate.graph_snippets[:5]:
        if path and excerpt:
            parts.append(f"\nSnippet from {path}:\n{excerpt[:600]}")
    parts.append(
        "\nReturn your response in two parts:\n"
        "1. A short markdown explanation of the fix\n"
        "2. A fenced ```diff block with the unified diff\n"
    )
    return "\n".join(parts)


class OpenHandsPRAgent:
    """The OpenHands Cloud implementation of :class:`PRAgent`."""

    name: str = "openhands"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = OPENHANDS_BASE_URL,
        timeout: float = OPENHANDS_TIMEOUT_SECONDS,
        max_wait_seconds: float = OPENHANDS_MAX_WAIT_SECONDS,
    ) -> None:
        if not api_key:
            raise ValueError(
                "OpenHandsPRAgent requires a non-empty api_key"
            )
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_wait = max_wait_seconds

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def run(
        self,
        candidate: PRCandidate,
        *,
        decision: Any | None = None,
    ) -> PRResult | None:
        """Run the agent on ``candidate``.

        Returns a :class:`PRResult` with the agent's
        decision + (optionally) the produced diff. The
        caller (the trigger flow) is responsible for
        persisting the PR via the existing Cat 23
        :class:`PRCreator` — the agent only produces
        content.
        """
        prompt = _prompt_for(candidate)
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                r = await client.post(
                    f"{self._base_url}/v1/conversations",
                    headers=self._headers(),
                    json={
                        "initial_user_message": prompt,
                        "repository": candidate.repo_full_name,
                        "branch": candidate.branch,
                        "draft": True,
                    },
                )
            if r.status_code not in (200, 201, 202):
                logger.debug(
                    "OpenHandsPRAgent.run start %s: %s",
                    r.status_code,
                    r.text[:200],
                )
                return None
            conv = r.json()
            conversation_id = str(
                conv.get("id") or conv.get("conversation_id") or "",
            )
            if not conversation_id:
                logger.debug(
                    "OpenHandsPRAgent.run: missing conversation id",
                )
                return None
            # Poll for the result. We use a short poll
            # interval (2s) so we don't burn budget on
            # sleeping too long, and we cap total wait
            # at ``_max_wait`` seconds.
            import asyncio
            elapsed = 0.0
            poll_interval = 2.0
            final_message = ""
            final_status = ""
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                while elapsed < self._max_wait:
                    await asyncio.sleep(poll_interval)
                    elapsed += poll_interval
                    poll = await client.get(
                        f"{self._base_url}/v1/conversations/{conversation_id}",
                        headers=self._headers(),
                    )
                    if poll.status_code != 200:
                        continue
                    payload = poll.json()
                    final_status = str(
                        payload.get("status") or payload.get("state") or "",
                    ).upper()
                    if final_status in (
                        "FINISHED", "COMPLETED", "DONE", "SUCCESS",
                    ):
                        # The response payload contains the
                        # final assistant message; pull it.
                        final_message = (
                            payload.get("message")
                            or payload.get("final_message")
                            or payload.get("output")
                            or ""
                        )
                        if isinstance(final_message, dict):
                            final_message = str(
                                final_message.get("content") or ""
                            )
                        break
                    if final_status in (
                        "ERROR", "FAILED", "CANCELLED",
                    ):
                        return PRResult(
                            kind="report_only",
                            reason=f"openhands_status={final_status}",
                            conversation_id=conversation_id,
                            raw=payload,
                        )
            if not final_message:
                return PRResult(
                    kind="report_only",
                    reason="openhands_no_message",
                    conversation_id=conversation_id,
                )
            diff = _extract_diff(final_message)
            # Heuristic: if the agent produced a diff,
            # it's a pr_ready / draft_pr. If the message
            # explicitly says "not code-fixable" or
            # similar, it's report_only.
            text_lower = final_message.lower()
            report_only_phrases = (
                "not code-fixable",
                "not a code issue",
                "not fixable in code",
                "infrastructure issue",
                "config issue",
            )
            if any(p in text_lower for p in report_only_phrases):
                return PRResult(
                    kind="report_only",
                    reason="agent_says_not_code_fixable",
                    body=final_message[:4000],
                    conversation_id=conversation_id,
                )
            if not diff:
                return PRResult(
                    kind="report_only",
                    reason="agent_no_diff",
                    body=final_message[:4000],
                    conversation_id=conversation_id,
                )
            # The agent's confidence is opaque to us;
            # the discipline layer already gated this
            # candidate, so any diff it produced is
            # at minimum a draft. We default to
            # ``draft_pr``; the caller can override to
            # ``pr_ready`` after running its own
            # validation pass.
            return PRResult(
                kind="draft_pr",
                body=final_message[:8000],
                diff=diff,
                conversation_id=conversation_id,
            )
        except Exception as exc:
            logger.debug("OpenHandsPRAgent.run: %s", exc)
            return None
