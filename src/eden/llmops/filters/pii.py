"""PII filter — wraps the existing ``PIIMasker`` as a ``GatewayFilter``.

The pre-registry inline code called ``PIIMasker.mask`` directly inside
``AIGateway.complete``. This filter preserves that behavior exactly
(masking emails, phones, SSNs, JWTs, IP addresses, etc.) but exposes it
through the registry so it can be:

  * enabled/disabled per-tenant via ``request.pii_filter_enabled``
  * disabled at runtime via ``gateway.set_filter_enabled("pii", False)``
  * ordered relative to other filters (secret-redaction, prompt-injection)
  * tested in isolation (no need to mock the whole gateway)

The default PII pattern set is taken from
``eden.data_platform.pii.PIIMasker.PATTERNS``. Operators may pass a
subset via ``PIIFilterConfig(enabled_patterns=[...])`` if a particular
tenant has a stricter or looser policy.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from eden.data_platform.pii import PIIMasker

logger = logging.getLogger(__name__)


@dataclass
class PIIFilterConfig:
    """Per-filter configuration. The dataclass is mutable so a single
    instance can be re-used across requests and reconfigured at runtime
    (e.g. when a tenant toggles PII on/off from the portal)."""

    mask_token: str = "REDACTED"
    enabled_patterns: set[str] | None = None
    enabled: bool = True


class PIIFilter:
    """Mask PII in ``request.prompt`` before it leaves the platform."""

    name = "pii"

    def __init__(self, config: PIIFilterConfig | None = None) -> None:
        self.config = config or PIIFilterConfig()
        self._masker = PIIMasker(mask_token=self.config.mask_token)

    def enabled(self, request: Any) -> bool:
        """Filter is enabled if (a) the global config says so and (b) the
        request has not opted out via ``pii_filter_enabled=False``.

        The default in the gateway was ``True`` — if a request doesn't
        set ``pii_filter_enabled`` at all, we mask. This matches the
        pre-registry behavior.
        """
        if not self.config.enabled:
            return False
        return bool(getattr(request, "pii_filter_enabled", True))

    def apply(self, request: Any) -> tuple[Any, list[str]]:
        if not getattr(request, "prompt", None):
            return request, []

        original_prompt: str = request.prompt
        scrubbed = original_prompt
        findings: list[str] = []

        patterns = self.config.enabled_patterns
        if patterns is None:
            # Use the full PIIMasker default
            scrubbed = self._masker.mask(original_prompt)
        else:
            for pii_type in patterns:
                pat = PIIMasker.PATTERNS.get(pii_type)
                if pat is None:
                    continue
                new = pat.sub(f"[{pii_type.upper()}_{self.config.mask_token}]", scrubbed)
                if new != scrubbed:
                    findings.append(pii_type)
                scrubbed = new

        if scrubbed != original_prompt:
            request.prompt = scrubbed
            # Surface to logs / metrics — gateway will log this.
            findings_msg = findings or "pii"
            logger.info(
                "PII filter masked content for tenant=%s: %s",
                getattr(request, "tenant_id", ""),
                findings_msg,
            )
            return request, [f"pii_masked:{','.join(findings) if isinstance(findings, list) else findings}"]

        return request, []
