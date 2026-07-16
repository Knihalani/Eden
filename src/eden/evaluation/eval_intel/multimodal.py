"""Multi-modal evaluation + Six-Modalities registry services (Cat 3) — real implementations.

Two services:

* :class:`MultiModalEvaluator` — score ``text``, ``image``,
  and ``audio`` inputs against a free-form spec (a list of
  criteria). Uses the existing
  :class:`eden.llm.client.OpenRouterClient` to call the LLM
  judge. Image and audio are routed to the LLM as a textual
  description in v1 (no real image/audio model is wired);
  the response carries a warning so the operator can tell
  the score is "text-only of a media URL".

  The :attr:`name` is ``"multimodal_evaluator"``.

* :class:`SixModalitiesRegistry` — declare one of the six
  Arize-style eval modalities (``llm_as_judge``, ``online``,
  ``offline``, ``trace_level``, ``session_level``,
  ``human_annotation``) for an org. Each declaration
  persists a row in ``eval_modality_declarations``.

  The :attr:`name` is ``"six_modalities"``.

Failure modes (per the appendix):

* Unsupported ``modality`` → 400 with a clear error.

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.llm.client import OpenRouterClient

from ._common import (
    MULTIMODAL_MODALITIES,
    SIX_MODALITIES,
    _bad_request_envelope,
    _insert_modality_declaration,
    _insert_multimodal_run,
    _ok_envelope,
    _parse_judge_response,
    _validate_modality,
    _validate_six_modality,
)

logger = logging.getLogger(__name__)


# Modality-specific prompt templates. The text template is
# the most direct; image/audio are routed as a textual
# description in v1 (no real image/audio model is wired).
_PROMPTS: dict[str, str] = {
    "text": (
        "You are an LLM judge scoring a text response.\n"
        "Criteria: {criteria}\n\n"
        "Input:\n{input_text}\n\n"
        "Return ONLY a JSON object: "
        '{{"score": <float 0..1>, "rationale": "<short>"}}'
    ),
    "image": (
        "You are an LLM judge scoring an image (URL: {input_url}).\n"
        "Criteria: {criteria}\n\n"
        "(Image content not provided in v1; scoring based on URL + criteria.)\n\n"
        "Return ONLY a JSON object: "
        '{{"score": <float 0..1>, "rationale": "<short>"}}'
    ),
    "audio": (
        "You are an LLM judge scoring an audio clip (URL: {input_url}).\n"
        "Criteria: {criteria}\n\n"
        "(Audio content not provided in v1; scoring based on URL + criteria.)\n\n"
        "Return ONLY a JSON object: "
        '{{"score": <float 0..1>, "rationale": "<short>"}}'
    ),
}


def _format_criteria(spec: dict[str, Any]) -> str:
    """Format the spec's ``criteria`` into a comma-separated
    string. Falls back to a default when the spec doesn't
    include a criteria list."""
    crit = spec.get("criteria") if isinstance(spec, dict) else None
    if isinstance(crit, (list, tuple)) and crit:
        return ", ".join(str(c)[:200] for c in crit)
    if isinstance(crit, str) and crit.strip():
        return crit[:500]
    return "general quality"


class MultiModalEvaluator:
    """Score ``text``, ``image``, or ``audio`` inputs against
    a spec.

    Public method :meth:`evaluate_text_image_audio` returns
    the live envelope on success, or a live "bad_request"
    envelope on unsupported modality.
    """

    name = "multimodal_evaluator"

    async def evaluate_text_image_audio(
        self,
        org_id: str,
        *,
        modality: str,
        input_url: str,
        spec: dict[str, Any],
    ) -> dict[str, Any]:
        # 1. Validate modality.
        if not _validate_modality(modality):
            return _bad_request_envelope(
                self.name,
                (
                    f"unsupported modality {modality!r}; "
                    f"expected one of {list(MULTIMODAL_MODALITIES)}"
                ),
            )
        if not isinstance(spec, dict):
            return _bad_request_envelope(
                self.name,
                "spec must be a dict",
            )

        criteria = _format_criteria(spec)
        prompt_template = _PROMPTS.get(modality, _PROMPTS["text"])
        if modality == "text":
            prompt = prompt_template.format(
                criteria=criteria,
                input_text=str(input_url or spec.get("input_text", ""))[:2000],
            )
        else:
            prompt = prompt_template.format(
                criteria=criteria,
                input_url=str(input_url or "")[:1000],
            )

        # 2. Call the LLM (best-effort). If the client is
        # missing or the call fails, return a 0.5 default
        # with a warning.
        score: float = 0.5
        rationale: str = ""
        message: str | None = None
        llm_client = None
        try:
            llm_client = OpenRouterClient()
        except Exception as exc:
            message = f"OpenRouterClient init failed: {exc}"
            llm_client = None
        if llm_client is not None:
            try:
                from eden.llm.internal_router import route_sync

                resp = route_sync(
                    "multimodal_evaluator",
                    prompt,
                    slot="fast",
                    max_tokens=160,
                    output_type="json",
                    llm_client=llm_client,
                    requires_quality_check=False,
                )
                score, rationale = _parse_judge_response(
                    getattr(resp, "content", ""),
                )
            except Exception as exc:
                message = f"llm call failed: {exc}"
                score = 0.5
                rationale = "multimodal_evaluator: llm_error"
        if modality != "text" and message is None:
            message = (
                f"{modality} modality routed as text in v1; "
                "score is the LLM's text-only verdict"
            )

        # 3. Persist (best-effort).
        await _insert_multimodal_run(
            org_id,
            modality=modality,
            input_url=str(input_url or "")[:4000],
            score=float(score),
            rationale=str(rationale or "")[:4000],
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "modality": modality,
                "input_url": input_url,
                "score": round(float(score), 4),
                "rationale": rationale,
                "message": message,
            },
        )


class SixModalitiesRegistry:
    """Arize-style six-modality eval registry.

    Public method :meth:`declare_modality` returns the live
    envelope on success, or a live "bad_request" envelope on
    unknown modality.
    """

    name = "six_modalities"

    async def declare_modality(
        self,
        org_id: str,
        *,
        modality: str,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        # 1. Validate modality.
        if not _validate_six_modality(modality):
            return _bad_request_envelope(
                self.name,
                (
                    f"unknown modality {modality!r}; "
                    f"expected one of {list(SIX_MODALITIES)}"
                ),
            )
        if not isinstance(config, dict):
            return _bad_request_envelope(
                self.name,
                "config must be a dict",
            )

        import json
        config_json = json.dumps(config)[:60000]

        # 2. Persist (best-effort, no DELETE on declaration —
        # each declaration is a new row in the audit log).
        await _insert_modality_declaration(
            org_id, modality=modality, config_json=config_json,
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "modality": modality,
                "config": config,
                "status": "declared",
            },
        )
