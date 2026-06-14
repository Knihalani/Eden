"""Intelligence Gap — Eval Quality (Cat 3) routes."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel

from eden.api.deps import get_current_user, require_feature_flag
from eden.evaluation.eval_intel import (
    AutoDatasetBridge,
    BooleanCategoricalScore,
    CLHFGenerator,
    CustomPythonEval,
    EvalRegistry,
    EvalToGuardrailLink,
    EvalVersioner,
    FailureClusterer,
    HumanInTheLoopService,
    MultiModalEvaluator,
    PairwiseAnnotationService,
    SixModalitiesRegistry,
    UserFeedbackService,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/eval",
    tags=["intelligence-eval"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

_versioner = EvalVersioner()
_registry = EvalRegistry()
_failure = FailureClusterer()
_clhf = CLHFGenerator()
_hil = HumanInTheLoopService()
_pairwise = PairwiseAnnotationService()
_multimodal = MultiModalEvaluator()
_promote = EvalToGuardrailLink()
_six_mod = SixModalitiesRegistry()
_bool_cat = BooleanCategoricalScore()
_custom = CustomPythonEval()
_feedback = UserFeedbackService()
_auto = AutoDatasetBridge()


# ─── Schemas ──────────────────────────────────────────────────────
class TagRequest(BaseModel):
    deployment_sha: str
    prompt_version: str
    judge_set: list[str]


class ClusterRequest(BaseModel):
    judge_name: str
    window: str = "24h"


class CLHFRequest(BaseModel):
    name: str
    examples: list[dict[str, Any]]


class HILTaskRequest(BaseModel):
    name: str
    spec: dict[str, Any]


class HILAnnotationRequest(BaseModel):
    task_id: str
    trace_id: str
    label: str
    rationale: str | None = None


class PairwiseQueueRequest(BaseModel):
    name: str
    spec: dict[str, Any]


class PairwisePreferenceRequest(BaseModel):
    queue_id: str
    variant_a_id: str
    variant_b_id: str
    preferred: str


class MultimodalRequest(BaseModel):
    modality: str
    input_url: str
    spec: dict[str, Any]


class PromoteRequest(BaseModel):
    judge_name: str
    threshold: float


class ModalityRequest(BaseModel):
    modality: str
    config: dict[str, Any]


class BooleanCategoricalRequest(BaseModel):
    score_type: str
    value: str


class CustomEvalRequest(BaseModel):
    name: str
    function_ref: str
    spec: dict[str, Any]


class FeedbackRequest(BaseModel):
    trace_id: str
    thumbs: str | None = None
    rating: int | None = None
    comment: str | None = None


class AutoDatasetRequest(BaseModel):
    judge_name: str
    target_dataset_name: str
    min_confidence: float = 0.85


# ─── Routes ───────────────────────────────────────────────────────
@router.post("/versions/tag")
async def tag_version(
    org_id: str = Path(...),
    body: TagRequest = Body(...),
) -> dict[str, Any]:
    return await _versioner.tag(
        org_id,
        deployment_sha=body.deployment_sha,
        prompt_version=body.prompt_version,
        judge_set=body.judge_set,
    )


@router.get("/versions")
async def list_versions(org_id: str = Path(...)) -> dict[str, Any]:
    return await _registry.list(org_id)


@router.post("/failure-clusters")
async def failure_clusters(
    org_id: str = Path(...),
    body: ClusterRequest = Body(...),
) -> dict[str, Any]:
    return await _failure.cluster(
        org_id, judge_name=body.judge_name, window=body.window
    )


@router.post("/clhf/generate")
async def clhf_generate(
    org_id: str = Path(...),
    body: CLHFRequest = Body(...),
) -> dict[str, Any]:
    return await _clhf.generate_custom_metric(
        org_id, name=body.name, examples=body.examples
    )


@router.post("/hil/tasks")
async def hil_create_task(
    org_id: str = Path(...),
    body: HILTaskRequest = Body(...),
) -> dict[str, Any]:
    return await _hil.create_annotation_task(
        org_id, name=body.name, spec=body.spec
    )


@router.post("/hil/annotations")
async def hil_submit(
    org_id: str = Path(...),
    body: HILAnnotationRequest = Body(...),
) -> dict[str, Any]:
    return await _hil.submit_annotation(
        org_id,
        task_id=body.task_id,
        trace_id=body.trace_id,
        label=body.label,
        rationale=body.rationale,
    )


@router.post("/pairwise/queues")
async def pairwise_create_queue(
    org_id: str = Path(...),
    body: PairwiseQueueRequest = Body(...),
) -> dict[str, Any]:
    return await _pairwise.create_queue(
        org_id, name=body.name, spec=body.spec
    )


@router.post("/pairwise/preferences")
async def pairwise_submit(
    org_id: str = Path(...),
    body: PairwisePreferenceRequest = Body(...),
) -> dict[str, Any]:
    return await _pairwise.submit_preference(
        org_id,
        queue_id=body.queue_id,
        variant_a_id=body.variant_a_id,
        variant_b_id=body.variant_b_id,
        preferred=body.preferred,
    )


@router.post("/multimodal/evaluate")
async def multimodal(
    org_id: str = Path(...),
    body: MultimodalRequest = Body(...),
) -> dict[str, Any]:
    return await _multimodal.evaluate_text_image_audio(
        org_id,
        modality=body.modality,
        input_url=body.input_url,
        spec=body.spec,
    )


@router.post("/promote-to-guardrail")
async def promote_to_guardrail(
    org_id: str = Path(...),
    body: PromoteRequest = Body(...),
) -> dict[str, Any]:
    return await _promote.promote_to_guardrail(
        org_id, judge_name=body.judge_name, threshold=body.threshold
    )


@router.post("/modalities/declare")
async def declare_modality(
    org_id: str = Path(...),
    body: ModalityRequest = Body(...),
) -> dict[str, Any]:
    return await _six_mod.declare_modality(
        org_id, modality=body.modality, config=body.config
    )


@router.post("/boolean-categorical")
async def boolean_categorical(
    org_id: str = Path(...),
    body: BooleanCategoricalRequest = Body(...),
) -> dict[str, Any]:
    return await _bool_cat.evaluate(
        org_id, score_type=body.score_type, value=body.value
    )


@router.post("/custom-eval/register")
async def custom_eval_register(
    org_id: str = Path(...),
    body: CustomEvalRequest = Body(...),
) -> dict[str, Any]:
    return await _custom.register(
        org_id,
        name=body.name,
        function_ref=body.function_ref,
        spec=body.spec,
    )


@router.post("/feedback")
async def feedback(
    org_id: str = Path(...),
    body: FeedbackRequest = Body(...),
) -> dict[str, Any]:
    return await _feedback.submit_thumbs_rating(
        org_id,
        trace_id=body.trace_id,
        thumbs=body.thumbs,
        rating=body.rating,
        comment=body.comment,
    )


@router.post("/auto-dataset")
async def auto_dataset(
    org_id: str = Path(...),
    body: AutoDatasetRequest = Body(...),
) -> dict[str, Any]:
    return await _auto.from_judge_failures(
        org_id,
        judge_name=body.judge_name,
        target_dataset_name=body.target_dataset_name,
        min_confidence=body.min_confidence,
    )
