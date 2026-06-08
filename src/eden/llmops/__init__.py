"""LLMOps module — provider abstraction, gateway, observability.

Phase 7.0 / Batch A1:
  * ``ai_gateway``  — provider-agnostic gateway with PII / filter pipeline
  * ``openai_adapter`` — OpenAI wire-format adapter (request/response
    shaping, SSE encoding, static model catalogue)

Other LLMOps modules (judges, prompts, eval, experiment tracking) live
elsewhere and are imported separately to avoid a cycle.
"""

from eden.llmops.ai_gateway import (
    AIGateway,
    BaseFilter,
    FilterSet,
    ModelRequest,
    ModelResponse,
    PIIFilter,
    Provider,
)
from eden.llmops.openai_adapter import (
    ChatCompletionRequest,
    CompletionRequest,
    EmbeddingRequest,
    STATIC_MODEL_CATALOGUE,
    aiter_to_bytes_stream,
    chat_to_provider_kwargs,
    embeddings_to_provider_kwargs,
    messages_to_prompt,
    shape_chat_completion_chunk,
    shape_chat_completion_response,
    shape_completion_response,
    shape_embedding_response,
    shape_models_response,
    sse_done,
    sse_format,
)

__all__ = [
    "AIGateway",
    "BaseFilter",
    "ChatCompletionRequest",
    "CompletionRequest",
    "EmbeddingRequest",
    "FilterSet",
    "ModelRequest",
    "ModelResponse",
    "PIIFilter",
    "Provider",
    "STATIC_MODEL_CATALOGUE",
    "aiter_to_bytes_stream",
    "chat_to_provider_kwargs",
    "embeddings_to_provider_kwargs",
    "messages_to_prompt",
    "shape_chat_completion_chunk",
    "shape_chat_completion_response",
    "shape_completion_response",
    "shape_embedding_response",
    "shape_models_response",
    "sse_done",
    "sse_format",
]
