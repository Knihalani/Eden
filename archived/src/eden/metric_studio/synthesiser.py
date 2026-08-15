"""RubricSynthesiser — from 2-5 user-labelled examples, synthesise a rubric prompt.

The "from examples" path is the Galileo CLHF (Continuous
Learning from Human Feedback) parity move: a customer provides
2-5 ``(input, output, label, rationale)`` examples, and the
:class:`OpenRouterClient` generates a rubric prompt that
captures the criteria the customer is using to distinguish
"passing" from "failing". The synthesised rubric is capped at
1,500 tokens (per the Cat 21 appendix spec), persisted to the
``custom_metric_runs`` audit log, and **gated on human-in-the-
loop approval** before it can be wrapped as a runtime judge by
:class:`JudgeFactory`.

Algorithm
---------
1. **Validate** the input — between 2 and 5 examples, each with
   ``input`` and ``output`` strings + a ``label`` (``"pass"`` /
   ``"fail"``) + an optional ``rationale`` (the human's
   reasoning). Returns ``_validation_envelope`` with a clear
   message on validation failure (never a stub
   ``not_implemented`` envelope).
2. **Compose** the synthesis prompt — the LLM is told the
   customer's domain, the labelled examples, and is asked to
   produce a rubric prompt that, when fed to a future judge
   LLM, will produce scores aligned with the customer's
   labels.
3. **Call** :class:`OpenRouterClient` with the ``"fast"`` slot
   (the synthesis task is small; the ``reasoning`` slot is
   overkill and triples the cost).
4. **Cap** the response at 1,500 tokens via
   :func:`_enforce_rubric_token_cap`.
5. **Persist** the synthesis to ``custom_metric_runs`` (status
   ``"synthesised"``, ``approval_status="pending"``).
6. **Return** the live envelope with ``rubric_id``,
   ``rubric_prompt``, ``rubric_tokens``, and
   ``approval_required=True``.

Approval
--------
A subsequent call to :meth:`approve` flips the audit log's
``approval_status`` to ``"approved"`` (or ``"rejected"``) and,
on approval, calls :func:`JudgeFactory.wrap_rubric_as_judge`
to register the rubric in the global :class:`JudgeRegistry`.
The closed-loop hook
:func:`MetricStudioHook.on_metric_promotion` fires on
approval so a Cat 3 judge regression can auto-roll-back a
promoted custom metric.

Failure modes
-------------
* LLM call raises (network, rate-limit, model error) — the
  audit log is NOT written, and the route returns a live
  envelope with ``live=False`` and a clear ``message``.
* LLM returns an empty / non-text response — same fallback.
* The caller passes 0 or 6+ examples — validation error,
  no LLM call is made.

See ``docs/observability-gap/21-custom-metric-studio.md``.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from ._common import (
    RUBRIC_TOKEN_CAP,
    _approximate_token_count,
    _delete_then_insert,
    _enforce_rubric_token_cap,
    _error_envelope,
    _json_dumps,
    _ok_envelope,
    _update_run_status,
    _validation_envelope,
)

logger = logging.getLogger(__name__)


# The synthesis prompt template. Kept as a module-level
# constant so the LLM call is deterministic on the prompt side
# (only the labelled examples change between calls).
#
# The output format is a single rubric prompt the customer
# will later feed to a future judge LLM. We ask for it in a
# specific structure (Domain, Pass criteria, Fail criteria,
# Edge cases) so the synthesised rubric is consistent across
# calls and easy to review in the portal.
_SYNTHESIS_PROMPT = """You are helping a customer build a custom evaluation metric for an LLM application.

The customer has provided {n_examples} labelled examples in the "{domain}" domain. Each example has:
- `input`: the user / task input the LLM saw
- `output`: the LLM's response that was rated
- `label`: either "pass" (the response is acceptable) or "fail" (the response is unacceptable)
- `rationale` (optional): the human's free-text reason for the label

Your job: produce a **rubric prompt** — a single, self-contained prompt that, when given to a future LLM judge alongside a new (input, output) pair, will cause that judge to emit scores aligned with the customer's labels.

The rubric prompt must:
1. State the domain and the customer's definition of "good" in 1-2 sentences.
2. List 3-6 concrete pass criteria (what a passing response looks like).
3. List 3-6 concrete fail criteria (what a failing response looks like), in the same order as the pass criteria so a reviewer can compare them.
4. Include 1-2 edge-case calls (cases that are easy to misjudge).
5. Be ≤ {token_cap} tokens. Be terse — the future LLM judge will be following this as instructions, not reading prose.

Here are the labelled examples:

{examples_block}

Return your answer as a single block of text — the rubric prompt, ready to use. Do NOT wrap it in JSON. Do NOT include any explanation, preamble, or trailing commentary.
"""


class RubricSynthesiser:
    """The from-examples rubric synthesis service.

    Mirrors the Cat 16 service shape (single class per file,
    ``name`` class attribute for the envelope ``feature``
    field, no module-level singleton — the route handler
    instantiates per call).
    """

    name = "rubric_synthesiser"

    # The LLM slot the synthesis call uses. ``fast`` is
    # deliberate — the synthesis task is small, the rubric is
    # small, and a 2-3× cost reduction over ``reasoning`` is
    # the difference between a feature customers use and a
    # feature they avoid.
    MODEL_SLOT: str = "fast"

    # The 2-5 example bounds. <2 means the LLM has too little
    # signal to synthesise a meaningful rubric; >5 means the
    # LLM starts to over-fit and the synthesis cost grows
    # super-linearly. Braintrust's generate-scorer uses the
    # same 2-5 range (the "few-shot sweet spot").
    MIN_EXAMPLES: int = 2
    MAX_EXAMPLES: int = 5

    async def from_examples(
        self,
        org_id: str,
        *,
        name: str,
        examples: list[dict[str, Any]],
        domain: str = "general",
    ) -> dict[str, Any]:
        """Synthesise a rubric from the customer's examples.

        Returns the live envelope with the synthesised rubric
        and a ``rubric_id`` the customer uses to either approve
        or reject the rubric in a follow-up call. The
        ``approval_required=True`` flag tells the front-end to
        show a "review and approve" panel before the rubric
        can be used as a runtime judge.
        """
        # ── 1. Validate input ─────────────────────────────────────
        if not isinstance(examples, list) or not examples:
            return _validation_envelope(
                self.name,
                "at least 2 examples are required",
                data={"approval_required": True},
            )
        if len(examples) < self.MIN_EXAMPLES:
            return _validation_envelope(
                self.name,
                f"need at least {self.MIN_EXAMPLES} examples, got {len(examples)}",
                data={"approval_required": True},
            )
        if len(examples) > self.MAX_EXAMPLES:
            return _validation_envelope(
                self.name,
                f"at most {self.MAX_EXAMPLES} examples, got {len(examples)}",
                data={"approval_required": True},
            )
        for i, ex in enumerate(examples):
            if not isinstance(ex, dict):
                return _validation_envelope(
                    self.name,
                    f"example {i} is not a dict",
                    data={"approval_required": True},
                )
            if not ex.get("input") or not ex.get("output"):
                return _validation_envelope(
                    self.name,
                    f"example {i} missing input or output",
                    data={"approval_required": True},
                )
            label = (ex.get("label") or "").lower()
            if label not in {"pass", "fail"}:
                return _validation_envelope(
                    self.name,
                    f"example {i} label must be 'pass' or 'fail', got {label!r}",
                    data={"approval_required": True},
                )

        # ── 2. Compose the synthesis prompt ──────────────────────
        examples_block = _format_examples_block(examples)
        prompt = _SYNTHESIS_PROMPT.format(
            n_examples=len(examples),
            domain=domain or "general",
            token_cap=RUBRIC_TOKEN_CAP,
            examples_block=examples_block,
        )

        # ── 3. Call the LLM ───────────────────────────────────────
        # OOM W4-3 (L12): when rubric_synthesis_batch_v1 is enabled, route
        # through the Anthropic Batch API (50% discount) instead of the
        # real-time OpenRouter path.  Defaults to False (no behaviour change).
        rubric_prompt = await _call_synthesis_llm_with_batch_fallback(
            prompt, org_id=org_id
        )
        if not rubric_prompt:
            # The LLM call failed (or returned empty). The audit
            # log is intentionally NOT written — the customer
            # can re-submit the same examples and try again.
            # Structured error (not not_implemented) so the UI
            # can distinguish "LLM unavailable" from a stub.
            return _error_envelope(
                self.name,
                "LLM synthesis failed; the OpenRouterClient returned no usable text",
                error_code="llm_unavailable",
                data={"approval_required": True},
            )

        # ── 4. Cap the rubric to 1,500 tokens ────────────────────
        rubric_prompt = _enforce_rubric_token_cap(rubric_prompt)
        rubric_tokens = _approximate_token_count(rubric_prompt)

        # ── 5. Persist to custom_metric_runs ──────────────────────
        rubric_id = f"rubric_{uuid.uuid4().hex[:12]}"
        await _delete_then_insert(
            org_id,
            rubric_id,
            "custom_metric_runs",
            [
                "metric_name",
                "domain",
                "synthesised_rubric",
                "rubric_tokens",
                "examples_json",
                "result_json",
                "status",
                "approval_status",
            ],
            [
                name or "Unnamed Metric",
                domain or "general",
                rubric_prompt,
                rubric_tokens,
                _json_dumps(examples),
                _json_dumps({"rubric_id": rubric_id, "approval_required": True}),
                "synthesised",
                "pending",
            ],
        )

        # ── 6. Return the live envelope ───────────────────────────
        return _ok_envelope(
            self.name,
            {
                "rubric_id": rubric_id,
                "name": name,
                "domain": domain or "general",
                "rubric_prompt": rubric_prompt,
                "rubric_tokens": rubric_tokens,
                "approval_required": True,
                "approval_status": "pending",
            },
        )

    async def approve(
        self,
        org_id: str,
        rubric_id: str,
        *,
        approved_by: str,
        approved: bool = True,
        rejection_reason: str | None = None,
        metric_name: str | None = None,
    ) -> dict[str, Any]:
        """Approve or reject a synthesised rubric.

        On approval, the audit-log row's ``approval_status`` is
        flipped to ``"approved"`` and the synthesised rubric is
        registered as a runtime judge in the global
        :class:`JudgeRegistry` via
        :func:`JudgeFactory.wrap_rubric_as_judge`. The
        closed-loop hook
        :func:`MetricStudioHook.on_metric_promotion` fires
        after the judge is registered.

        On rejection, the audit-log row's ``approval_status``
        is flipped to ``"rejected"`` with the reviewer's
        reason. No judge is registered, no hook fires.
        """
        if not rubric_id:
            return _validation_envelope(
                self.name,
                "rubric_id is required",
            )

        # Read the synthesised rubric from the audit log.
        rubric_prompt, existing_name, domain = await _fetch_rubric_row(
            org_id, rubric_id
        )
        if not rubric_prompt:
            return _error_envelope(
                self.name,
                f"no synthesised rubric found for rubric_id={rubric_id!r}",
                error_code="rubric_not_found",
            )

        if approved:
            await _update_run_status(
                org_id,
                rubric_id,
                status="approved",
                approval_status="approved",
                approved_by=approved_by,
            )
            # Wrap the rubric as a runtime judge. The factory
            # is responsible for the JudgeRegistry + hook
            # firing. We lazy-import to keep the import graph
            # of the synthesiser module light.
            from .judge_factory import JudgeFactory

            metric_id = f"metric_{uuid.uuid4().hex[:12]}"
            wrap = await JudgeFactory().wrap_rubric_as_judge(
                org_id,
                metric_id=metric_id,
                rubric_prompt=rubric_prompt,
                name=metric_name or existing_name or "Custom Metric",
                rubric_id=rubric_id,
                domain=domain or "general",
            )
            return _ok_envelope(
                self.name,
                {
                    "rubric_id": rubric_id,
                    "metric_id": wrap.get("metric_id"),
                    "judge_id": wrap.get("judge_name"),
                    "approval_status": "approved",
                    "approved_by": approved_by,
                },
            )
        else:
            await _update_run_status(
                org_id,
                rubric_id,
                status="rejected",
                approval_status="rejected",
                approved_by=approved_by,
                rejection_reason=rejection_reason or "(no reason given)",
            )
            return _ok_envelope(
                self.name,
                {
                    "rubric_id": rubric_id,
                    "approval_status": "rejected",
                    "approved_by": approved_by,
                    "rejection_reason": rejection_reason or "(no reason given)",
                },
            )


# ── Internal helpers (module-private) ───────────────────────────────


def _format_examples_block(examples: list[dict[str, Any]]) -> str:
    """Format the 2-5 labelled examples into the synthesis
    prompt's ``examples_block`` slot. Each example becomes
    3-5 lines (label, input, output, optional rationale)
    so the LLM can see the pattern at a glance."""
    lines: list[str] = []
    for i, ex in enumerate(examples, start=1):
        lines.append(f"--- Example {i} ({ex.get('label', '?').upper()}) ---")
        lines.append(f"Input: {ex.get('input', '')}")
        lines.append(f"Output: {ex.get('output', '')}")
        if ex.get("rationale"):
            lines.append(f"Rationale: {ex['rationale']}")
        lines.append("")
    return "\n".join(lines)


async def _call_synthesis_llm(prompt: str) -> str | None:
    """Call the OpenRouterClient in the ``fast`` slot.

    Returns the rubric text, or ``None`` on any failure. The
    function intentionally swallows all exceptions — the caller
    treats any failure as "synthesis failed" and the audit log
    is NOT written.

    The ``agent`` name is ``metric_studio_synthesiser`` so the
    circuit-breaker telemetry + cost tracking in
    :class:`OpenRouterClient` can attribute these calls
    correctly.
    """
    try:
        from eden.llm.internal_router import route_async

        t0 = time.monotonic()
        resp = await route_async(
            "metric_studio_synthesiser",
            prompt,
            slot=self_slot(),
            max_tokens=RUBRIC_TOKEN_CAP + 256,
            output_type="json",
            requires_quality_check=False,
            description="Synthesize custom metric rubric",
        )
        latency_ms = (time.monotonic() - t0) * 1000.0
        content = (getattr(resp, "content", "") or "").strip()
        if not content:
            return None
        logger.debug(
            "metric_studio.synthesiser: synthesis ok (%.0fms, %d chars)",
            latency_ms,
            len(content),
        )
        return content
    except Exception as exc:
        logger.debug("metric_studio.synthesiser: llm call failed: %s", exc)
        return None


def self_slot() -> str:
    """Module-level indirection so tests can monkeypatch the
    LLM slot without importing :class:`RubricSynthesiser`."""
    return RubricSynthesiser.MODEL_SLOT


async def _call_synthesis_llm_with_batch_fallback(
    prompt: str, *, org_id: str
) -> str | None:
    """Call the synthesis LLM, optionally via the Anthropic Batch API.

    OOM W4-3 (L12) — reference integration for the Batch API offline lane.

    When ``settings.rubric_synthesis_batch_v1 = True`` **and**
    ``settings.anthropic_api_key`` is non-empty, the synthesis LLM call is
    routed through the Anthropic Messages Batch API (50% cost discount).
    Otherwise falls back to the normal real-time :func:`_call_synthesis_llm`
    path so default behaviour is unchanged.

    Args:
        prompt: The fully-composed synthesis prompt.
        org_id: Used only for logging; not sent to the API.

    Returns:
        The synthesised rubric text, or ``None`` on any failure.
    """
    try:
        from eden.config import get_settings

        settings = get_settings()
        use_batch = (
            getattr(settings, "rubric_synthesis_batch_v1", False)
            and bool((getattr(settings, "anthropic_api_key", "") or "").strip())
        )
    except Exception:
        use_batch = False

    if not use_batch:
        # Default path — no behaviour change.
        return await _call_synthesis_llm(prompt)

    # Batch API path — OOM W4-3 reference integration.
    try:
        from eden.llm.batch_client import AnthropicBatchClient, BatchRequest

        client = AnthropicBatchClient()
        # Use the same model slot/class as the real-time path.  The batch
        # API only accepts native Anthropic model IDs (not OpenRouter slugs).
        # Default to claude-haiku-4-5; operators can override via env.
        from eden.config import get_settings as _gs

        _batch_model = (
            getattr(_gs(), "judges_model_override", "")
            or "claude-haiku-4-5"
        )
        req = BatchRequest(
            custom_id=f"rubric_synthesis_{org_id}",
            model=_batch_model,
            max_tokens=RUBRIC_TOKEN_CAP + 256,
            messages=[{"role": "user", "content": prompt}],
        )
        results = await client.run([req], poll_interval=5.0, max_polls=60)
        for row in results:
            if row.get("custom_id") == f"rubric_synthesis_{org_id}":
                content = (row.get("content") or "").strip()
                if content:
                    logger.debug(
                        "metric_studio.synthesiser: batch synthesis ok "
                        "(%d chars, org=%s)", len(content), org_id
                    )
                    return content
        logger.debug(
            "metric_studio.synthesiser: batch returned no content for org=%s", org_id
        )
        return None
    except Exception as exc:
        logger.warning(
            "metric_studio.synthesiser: batch call failed (%s), "
            "falling back to real-time path", exc
        )
        # Graceful degradation: fall back to real-time path on any batch error.
        return await _call_synthesis_llm(prompt)


async def _fetch_rubric_row(
    org_id: str, rubric_id: str
) -> tuple[str | None, str | None, str | None]:
    """Read the synthesised rubric prompt + name + domain from
    the ``custom_metric_runs`` audit log for the
    approve / reject path. Returns ``(None, None, None)`` when
    the row doesn't exist (so the route can return a clean
    "not found" envelope)."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("metric_studio.synthesiser: postgres import failed: %s", exc)
        return None, None, None
    client = await get_postgres_client()
    if client is None:
        return None, None, None
    try:
        row = await client.fetchrow(
            "SELECT synthesised_rubric, metric_name, domain "
            "FROM custom_metric_runs WHERE org_id = $1 AND id = $2",
            org_id,
            rubric_id,
        )
    except Exception as exc:
        logger.debug("metric_studio.synthesiser: fetch_rubric_row failed: %s", exc)
        return None, None, None
    if row is None:
        return None, None, None
    return (
        row.get("synthesised_rubric"),
        row.get("metric_name"),
        row.get("domain"),
    )
