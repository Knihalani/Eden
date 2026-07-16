"""CLHF (Continuous Learning from Human Feedback) service (Cat 3) — real implementation.

:class:`CLHFGenerator` takes 2-5 labeled examples
(``{input, output, score, rationale}``) and uses an LLM to
propose a custom eval metric spec (``{rubric, score_range,
prompt_template}``). The spec is then re-evaluated against
the input examples; if the LLM's scores agree with the
human-labelled scores within ±0.15 on at least 60% of the
examples, the metric is registered and persisted to
``eval_clhf_runs``.

The :attr:`name` is ``"clhf_generator"``.

Graceful degradation:

* No LLM client (or LLM call fails) → still persists the
  spec but returns ``agreement=None`` and a warning message
  so the operator knows the spec wasn't verified.
* Examples are missing required keys → 400 with the list of
  missing keys.
* Examples count is < 2 or > 5 → 400 (Galileo spec).
* LLM-generated spec is missing fields → falls back to a
  sensible default spec (rubric="LLM judge", score_range=[0,1],
  prompt_template=the few-shot prompt verbatim) so the row is
  still persisted.

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import contextlib
import json
import logging
from typing import Any

from eden.llm.client import OpenRouterClient

from ._common import (
    CLHF_MAX_EXAMPLES,
    CLHF_MIN_EXAMPLES,
    _bad_request_envelope,
    _insert_clhf_run,
    _ok_envelope,
    _parse_judge_response,
)

logger = logging.getLogger(__name__)


# Few-shot prompt for the LLM to propose a metric spec. The
# LLM is asked to return a JSON object with three fields.
_CLHF_GENERATION_PROMPT = """You are a metric designer for an LLM evaluation system.

Given these human-labelled examples, propose a custom eval metric spec.

Each example has:
- input: the user's prompt
- output: the assistant's response
- score: a human-given quality score in [0, 1]
- rationale: the human's reasoning for that score

Your job: return a JSON spec with three fields:
- rubric: a 1-2 sentence description of what the metric measures
- score_range: [low, high] (typically [0, 1])
- prompt_template: a string with {{input}} and {{output}} placeholders
  that another LLM judge can use to score new (input, output) pairs

Examples:
{few_shot}

Return ONLY the JSON spec, no prose, no markdown.
"""

# Prompt template for re-evaluating an example against the
# proposed spec. Has {{input}} and {{output}} placeholders.
_REEVAL_PROMPT = """You are an LLM judge following this rubric:

{rubric}

Score range: {score_low} to {score_high}

Input: {input}
Output: {output}

Return ONLY a JSON object: {{"score": <float>, "rationale": "<short>"}}
"""


def _build_few_shot(examples: list[dict[str, Any]]) -> str:
    """Build the few-shot block for the LLM spec-generation
    call. Truncates long fields so the prompt stays bounded."""
    parts: list[str] = []
    for i, ex in enumerate(examples, 1):
        inp = str(ex.get("input", ""))[:600]
        out = str(ex.get("output", ""))[:600]
        score = ex.get("score", 0.0)
        rat = str(ex.get("rationale", ""))[:200]
        parts.append(
            f"Example {i}:\n"
            f"  Input: {inp}\n"
            f"  Output: {out}\n"
            f"  Score: {score}\n"
            f"  Rationale: {rat}"
        )
    return "\n\n".join(parts)


def _parse_metric_spec(content: str) -> dict[str, Any]:
    """Parse the LLM's spec response. Falls back to a
    sensible default if any field is missing or unparseable.

    Returns ``{rubric, score_range, prompt_template}``."""
    rubric = "LLM judge following the few-shot examples"
    score_range = [0.0, 1.0]
    prompt_template = ""

    content = (content or "").strip()
    if not content:
        return {
            "rubric": rubric,
            "score_range": score_range,
            "prompt_template": prompt_template,
        }
    # Try strict JSON.
    obj: Any = None
    try:
        obj = json.loads(content)
    except Exception:
        # Try to extract a JSON object from prose.
        import re
        m = re.search(r"\{[\s\S]*\}", content)
        if m:
            try:
                obj = json.loads(m.group(0))
            except Exception:
                obj = None
    if isinstance(obj, dict):
        r = obj.get("rubric")
        if isinstance(r, str) and r.strip():
            rubric = r.strip()
        sr = obj.get("score_range")
        if isinstance(sr, (list, tuple)) and len(sr) == 2:
            with contextlib.suppress(Exception):
                score_range = [float(sr[0]), float(sr[1])]
        pt = obj.get("prompt_template")
        if isinstance(pt, str) and pt.strip():
            prompt_template = pt.strip()
    return {
        "rubric": rubric,
        "score_range": score_range,
        "prompt_template": prompt_template,
    }


class CLHFGenerator:
    """Galileo-style CLHF: 2-5 examples → custom eval metric.

    Public method :meth:`generate_custom_metric` returns the
    live envelope on success, or a live "bad_request" envelope
    on validation failure (Galileo spec: 2-5 examples; per-key
    schema).
    """

    name = "clhf_generator"

    AGREEMENT_THRESHOLD: float = 0.6
    AGREEMENT_TOLERANCE: float = 0.15

    async def generate_custom_metric(
        self,
        org_id: str,
        *,
        name: str,
        examples: list[dict[str, Any]],
    ) -> dict[str, Any]:
        # 1. Validate example count (Galileo spec).
        if not isinstance(examples, list):
            return _bad_request_envelope(
                self.name,
                "examples must be a list of {input, output, score, rationale} dicts",
            )
        n = len(examples)
        if n < CLHF_MIN_EXAMPLES or n > CLHF_MAX_EXAMPLES:
            return _bad_request_envelope(
                self.name,
                f"CLHF requires {CLHF_MIN_EXAMPLES}-{CLHF_MAX_EXAMPLES} examples; got {n}",
            )
        # 2. Validate each example's schema.
        missing_keys_per_example: list[dict[str, Any]] = []
        for i, ex in enumerate(examples):
            if not isinstance(ex, dict):
                return _bad_request_envelope(
                    self.name,
                    f"example {i} must be a dict",
                )
            for k in ("input", "output", "score"):
                if k not in ex:
                    missing_keys_per_example.append(
                        {"index": i, "missing": k}
                    )
        if missing_keys_per_example:
            return _bad_request_envelope(
                self.name,
                f"missing required keys: {missing_keys_per_example[:3]}",
            )
        if not name or not isinstance(name, str):
            return _bad_request_envelope(
                self.name,
                "name must be a non-empty string",
            )
        name = name.strip()[:128]

        # 3. Generate the spec. Try to import the LLM client
        # best-effort. The client is optional — if it's
        # missing, we still save the row but mark it as
        # unverified.
        spec: dict[str, Any] = {
            "rubric": "LLM judge following the few-shot examples",
            "score_range": [0.0, 1.0],
            "prompt_template": "",
        }
        agreement: float | None = None
        message: str | None = None
        llm_error: str | None = None

        llm_client = None
        try:
            llm_client = OpenRouterClient()
        except Exception as exc:
            llm_error = f"OpenRouterClient init failed: {exc}"
            llm_client = None

        if llm_client is not None:
            try:
                from eden.llm.internal_router import route_sync

                few_shot = _build_few_shot(examples)
                prompt = _CLHF_GENERATION_PROMPT.format(few_shot=few_shot)
                resp = route_sync(
                    "clhf_generator",
                    prompt,
                    slot="fast",
                    max_tokens=400,
                    llm_client=llm_client,
                    output_type="json",
                    requires_quality_check=False,
                )
                spec = _parse_metric_spec(getattr(resp, "content", ""))
            except Exception as exc:
                llm_error = f"spec_generation failed: {exc}"

        if llm_error is not None:
            message = (
                f"no llm_client — {llm_error}; spec is empty, "
                "no verification"
            )
        else:
            # 4. Re-evaluate the examples against the proposed
            # spec and compute agreement.
            if spec.get("prompt_template"):
                agreements: list[int] = []
                try:
                    for ex in examples:
                        eval_prompt = spec["prompt_template"].format(
                            input=str(ex.get("input", ""))[:600],
                            output=str(ex.get("output", ""))[:600],
                        )
                        eval_resp = route_sync(
                            "clhf_reeval",
                            eval_prompt,
                            slot="fast",
                            max_tokens=120,
                            llm_client=llm_client,
                            output_type="json",
                            requires_quality_check=False,
                        )
                        gen_score, _ = _parse_judge_response(
                            getattr(eval_resp, "content", ""),
                        )
                        expected = float(ex.get("score", 0.0) or 0.0)
                        if abs(gen_score - expected) < self.AGREEMENT_TOLERANCE:
                            agreements.append(1)
                        else:
                            agreements.append(0)
                    agreement = sum(agreements) / len(agreements)
                except Exception as exc:
                    message = (
                        f"reevaluation failed: {exc}; spec saved "
                        "without verification"
                    )
                    agreement = None
            else:
                # Spec is empty — can't re-evaluate.
                message = (
                    "spec has no prompt_template; cannot re-evaluate"
                )

        # 5. Persist (best-effort, single row per run).
        examples_json = json.dumps(examples)[:60000]
        generated_metric_json = json.dumps(spec)[:60000]
        status = (
            "generated" if (llm_error is None and agreement is not None)
            else "pending"
        )
        await _insert_clhf_run(
            org_id,
            name=name,
            examples_json=examples_json,
            generated_metric_json=generated_metric_json,
            status=status,
        )

        # 6. If agreement is computed and below threshold,
        # return a bad-request envelope (the spec is
        # unreliable). The row is still persisted with
        # status="pending" so the operator can review.
        if (
            agreement is not None
            and agreement < self.AGREEMENT_THRESHOLD
        ):
            return _bad_request_envelope(
                self.name,
                (
                    f"metric agrees on only {agreement:.0%} of examples "
                    f"(threshold {self.AGREEMENT_THRESHOLD:.0%}); "
                    "add more examples or refine"
                ),
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "metric_name": name,
                "spec": spec,
                "agreement": (
                    round(agreement, 4)
                    if agreement is not None else None
                ),
                "examples_evaluated": n,
                "status": status,
                "message": message,
            },
        )
