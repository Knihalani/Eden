"""Live configuration surface for OTel Collector policies (Cat 22).

The in-process tail-sampling / K8s-enrichment stack was removed
per upgradespec §D.1. These helpers expose the *deployed*
collector policies from ``deploy/otel-collector-config.yaml``
(parsed when available, otherwise a static mirror of the same
file) so the APM-depth routes can return a live configuration
surface instead of 501.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Mirror of deploy/otel-collector-config.yaml — kept in sync so
# the API still returns structured config when the YAML file is
# not present in the runtime image.
_STATIC_TAIL_SAMPLING: dict[str, Any] = {
    "decision_wait": "10s",
    "num_traces": 20000,
    "expected_new_traces_per_sec": 5000,
    "policies": [
        {
            "name": "eden_keep",
            "type": "string_attribute",
            "string_attribute": {"key": "eden.keep", "values": ["true"]},
        },
        {
            "name": "eden_loop",
            "type": "string_attribute",
            "string_attribute": {
                "key": "eden.loop_verdict",
                "values": ["true"],
            },
        },
        {
            "name": "eden_tool_error",
            "type": "string_attribute",
            "string_attribute": {
                "key": "eden.tool_error",
                "values": ["true"],
            },
        },
        {
            "name": "eden_stumble",
            "type": "string_attribute",
            "string_attribute": {
                "key": "eden.stumble",
                "values": ["true"],
            },
        },
        {
            "name": "errors",
            "type": "status_code",
            "status_code": {"status_codes": ["ERROR"]},
        },
        {
            "name": "slow",
            "type": "latency",
            "latency": {"threshold_ms": 5000},
        },
        {
            "name": "force_trace",
            "type": "string_attribute",
            "string_attribute": {
                "key": "eden.force_trace",
                "values": ["true"],
            },
        },
        {
            "name": "probabilistic",
            "type": "probabilistic",
            "probabilistic": {"sampling_percentage": 15},
        },
    ],
}

_STATIC_K8S_ATTRIBUTES: dict[str, Any] = {
    "passthrough": False,
    "auth_type": "serviceAccount",
    "extract": {
        "metadata": [
            "k8s.pod.name",
            "k8s.namespace.name",
            "k8s.deployment.name",
        ],
    },
    "extract_from_env": [
        "K8S_POD_NAME",
        "K8S_NAMESPACE",
        "K8S_DEPLOYMENT_NAME",
    ],
}

_CONFIG_CANDIDATES: tuple[Path, ...] = (
    Path("deploy/otel-collector-config.yaml"),
    Path("/workspace/deploy/otel-collector-config.yaml"),
    Path(__file__).resolve().parents[3] / "deploy" / "otel-collector-config.yaml",
)


def _load_yaml(path: Path) -> dict[str, Any] | None:
    try:
        import yaml  # type: ignore[import-untyped]

        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        return data if isinstance(data, dict) else None
    except Exception as exc:  # noqa: BLE001
        logger.debug("otel config parse failed for %s: %s", path, exc)
        return None


@lru_cache(maxsize=1)
def load_otel_collector_config() -> dict[str, Any]:
    """Return parsed collector config or the static mirror."""
    for path in _CONFIG_CANDIDATES:
        if path.is_file():
            parsed = _load_yaml(path)
            if parsed is not None:
                return {
                    "source": str(path),
                    "parsed": True,
                    "config": parsed,
                }
    return {
        "source": "static:deploy/otel-collector-config.yaml",
        "parsed": False,
        "config": {
            "processors": {
                "tail_sampling": _STATIC_TAIL_SAMPLING,
                "k8sattributes": _STATIC_K8S_ATTRIBUTES,
            },
        },
    }


def tail_sampling_config() -> dict[str, Any]:
    """Structured tail_sampling policy (live configuration surface)."""
    loaded = load_otel_collector_config()
    processors = (loaded.get("config") or {}).get("processors") or {}
    policy = processors.get("tail_sampling") or _STATIC_TAIL_SAMPLING
    return {
        "status": "ok",
        "feature": "otel_tail_sampling",
        "live": True,
        "message": (
            "Live OTel Collector tail_sampling configuration. "
            "Sampling decisions are enforced by the collector, "
            "not in-process."
        ),
        "data": {
            "surface": "live_configuration",
            "config_source": loaded.get("source"),
            "parsed_from_file": bool(loaded.get("parsed")),
            "processor": "tail_sampling",
            "config": policy,
            "config_hint": "deploy/otel-collector-config.yaml",
        },
    }


def k8s_attributes_config() -> dict[str, Any]:
    """Structured k8sattributes processor config."""
    loaded = load_otel_collector_config()
    processors = (loaded.get("config") or {}).get("processors") or {}
    policy = processors.get("k8sattributes") or _STATIC_K8S_ATTRIBUTES
    return {
        "status": "ok",
        "feature": "otel_k8sattributes",
        "live": True,
        "message": (
            "Live OTel Collector k8sattributes configuration. "
            "Pod/namespace/deployment attributes are injected by "
            "the collector."
        ),
        "data": {
            "surface": "live_configuration",
            "config_source": loaded.get("source"),
            "parsed_from_file": bool(loaded.get("parsed")),
            "processor": "k8sattributes",
            "config": policy,
            "config_hint": "deploy/otel-collector-config.yaml",
        },
    }


def evaluate_sampling_preview(
    *,
    attributes: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Preview which tail_sampling policy would keep a span.

    This is a configuration-surface preview (not an in-process
    sampler). It walks the deployed policy list and reports the
    first matching keep rule.
    """
    base = tail_sampling_config()
    policies = list((base["data"]["config"] or {}).get("policies") or [])
    attrs = attributes or {}
    matched: str | None = None
    reason = "fallback:probabilistic"

    def _attr_match(policy: dict[str, Any]) -> bool:
        spec = policy.get("string_attribute") or {}
        key = spec.get("key")
        values = set(spec.get("values") or [])
        if not key:
            return False
        return str(attrs.get(key, "")) in values

    for policy in policies:
        name = str(policy.get("name") or "")
        ptype = str(policy.get("type") or "")
        if ptype == "string_attribute" and _attr_match(policy):
            matched = name
            reason = f"string_attribute:{name}"
            break
        if ptype == "status_code" and str(attrs.get("status_code", "")).upper() == "ERROR":
            matched = name
            reason = "status_code:ERROR"
            break
        if ptype == "latency":
            threshold = float(
                (policy.get("latency") or {}).get("threshold_ms", 5000)
            )
            try:
                latency = float(attrs.get("latency_ms", 0) or 0)
            except (TypeError, ValueError):
                latency = 0.0
            if latency >= threshold:
                matched = name
                reason = f"latency>={threshold}"
                break
        if ptype == "probabilistic" and matched is None:
            matched = name
            reason = "probabilistic_fallback"

    base["data"] = {
        **base["data"],
        "preview": {
            "matched_policy": matched,
            "reason": reason,
            "keep": matched is not None and matched != "probabilistic",
            "attributes_inspected": sorted(attrs.keys()),
        },
    }
    return base


__all__ = [
    "evaluate_sampling_preview",
    "k8s_attributes_config",
    "load_otel_collector_config",
    "tail_sampling_config",
]
