"""Eden LLMOps & Experiment Tracking package.

Audit 2026-07-06 — package __init__ is lazy via PEP 562. Previously
``from eden.llmops.ai_gateway import AIGateway`` pulled every
llmops submodule (filters/pII, pricing, semantic_cache, etc.)
on first call. Now each submodule is imported on first attribute
access; the public API is unchanged.
"""

from __future__ import annotations

__all__ = [
    "AIGateway",
    "ModelRequest",
    "ModelResponse",
    "ExperimentTracker",
    "Experiment",
    "ExperimentRun",
    "ModelArtifactRegistry",
    "ArtifactType",
    "ModelArtifact",
    "ArtifactEvaluation",
    "PromptRegistry",
    "PromptTemplate",
    "PromptABTest",
    "SemanticCache",
    "CacheEntry",
    "ProductionMonitor",
    "MonitoringAlert",
    "AlertSeverity",
    "ModelHealthSnapshot",
    "PricingCatalog",
    "PricingRecord",
    # Submodule re-exports for ``from eden.llmops import ai_gateway``.
    "ai_gateway",
    "experiment_tracker",
    "model_registry",
    "production_monitor",
    "prompt_registry",
    "semantic_cache",
    "filters",
    "pricing",
]


_NAME_TO_MODULE = {
    "AIGateway": "ai_gateway",
    "ModelRequest": "ai_gateway",
    "ModelResponse": "ai_gateway",
    "ExperimentTracker": "experiment_tracker",
    "Experiment": "experiment_tracker",
    "ExperimentRun": "experiment_tracker",
    "ModelArtifactRegistry": "model_registry",
    "ArtifactType": "model_registry",
    "ModelArtifact": "model_registry",
    "ArtifactEvaluation": "model_registry",
    "PromptRegistry": "prompt_registry",
    "PromptTemplate": "prompt_registry",
    "PromptABTest": "prompt_registry",
    "SemanticCache": "semantic_cache",
    "CacheEntry": "semantic_cache",
    "ProductionMonitor": "production_monitor",
    "MonitoringAlert": "production_monitor",
    "AlertSeverity": "production_monitor",
    "ModelHealthSnapshot": "production_monitor",
    "PricingCatalog": "pricing",
    "PricingRecord": "pricing",
}


def __getattr__(name: str):
    """PEP 562 — lazy module attribute access."""
    if name in (
        "ai_gateway", "experiment_tracker", "model_registry",
        "production_monitor", "prompt_registry", "semantic_cache",
        "filters", "pricing",
    ):
        import importlib
        submodule = importlib.import_module(f".{name}", __name__)
        globals()[name] = submodule
        return submodule
    mod_name = _NAME_TO_MODULE.get(name)
    if mod_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib
    submodule = importlib.import_module(f".{mod_name}", __name__)
    value = getattr(submodule, name)
    globals()[name] = value
    return value
