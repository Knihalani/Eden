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
from dataclasses import dataclass
from typing import Any

from eden.data_platform.pii import (
    PIIMasker,
    PIIMaskingError,
    PIIPolicy,
)

logger = logging.getLogger(__name__)


@dataclass
class PIIFilterConfig:
    """Per-filter configuration. The dataclass is mutable so a single
    instance can be re-used across requests and reconfigured at runtime
    (e.g. when a tenant toggles PII on/off from the portal).

    ``policy`` is the resolved :class:`PIIPolicy` to use as the
    default when the gateway doesn't pass one explicitly. The
    gateway always passes one (per-tenant), so this only matters
    for tests + the legacy ``AIGateway`` code path.
    """

    mask_token: str = "REDACTED"
    enabled_patterns: set[str] | None = None
    enabled: bool = True
    policy: PIIPolicy | None = None

def _resolve_policy_for_request(
    request: Any,
    *,
    supplied: PIIPolicy | None,
    config: PIIFilterConfig,
) -> PIIPolicy:
    """Pick the policy that applies to this request.

    Priority (highest first):

      1. ``supplied`` (the gateway's per-tenant policy from
         ``org_pii_policies``).
      2. ``config.policy`` (the filter's instance default — used
         in tests + the legacy ``AIGateway`` path).
      3. ``request.policy`` if the caller attached one to the
         request.
      4. The platform default :class:`PIIPolicy` (``mode="redact"``).
    """
    if supplied is not None:
        return supplied
    if config.policy is not None:
        return config.policy
    req_policy = getattr(request, "policy", None)
    if isinstance(req_policy, PIIPolicy):
        return req_policy
    return PIIPolicy()





class PIIFilter:
    """Mask PII in ``request.prompt`` before it leaves the platform."""

    name = "pii"

    def __init__(
        self,
        config: PIIFilterConfig | None = None,
        *,
        policy: PIIPolicy | None = None,
    ) -> None:
        if config is not None and policy is not None and config.policy is None:
            config.policy = policy
        self.config = config or PIIFilterConfig()
        if self.config.policy is None:
            self.config.policy = policy or PIIPolicy()
        # Build a default masker; per-request maskers are built in
        # ``apply`` so the resolved policy wins over the default.
        self._masker = PIIMasker(
            policy=self.config.policy,
            mask_token=self.config.mask_token,
        )

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

    def apply(
        self,
        request: Any,
        *,
        policy: PIIPolicy | None = None,
    ) -> tuple[Any, list[str]]:
        if not getattr(request, "prompt", None):
            return request, []

        active_policy = _resolve_policy_for_request(
            request,
            supplied=policy,
            config=self.config,
        )

        # ``mode == "off"`` is the documented "designed to use the
        # PII" case: skip masking entirely. Per-request opt-out
        # (``pii_filter_enabled = False``) does the same thing but
        # is request-scoped.
        if active_policy.mode == "off":
            return request, ["pii_bypassed:mode_off"]
        if not bool(getattr(request, "pii_filter_enabled", True)):
            return request, ["pii_bypassed:per_request"]

        original_prompt: str = request.prompt
        scrubbed = original_prompt
        findings: list[str] = []

        # Honour the per-tenant policy's active categories. The
        # ``PIIFilterConfig.enabled_patterns`` (legacy test-only knob)
        # still wins when set explicitly so existing tests don't
        # regress.
        patterns = self.config.enabled_patterns
        if patterns is None:
            masker = PIIMasker(
                policy=active_policy,
                mask_token=self.config.mask_token,
            )
            try:
                scrubbed = masker.mask(original_prompt)
            except PIIMaskingError as exc:
                # Fail-closed: tenant policy says any credential
                # detection must abort. Propagate so the gateway
                # can return 422.
                logger.info(
                    "PII filter fail-closed for tenant=%s: %s",
                    getattr(request, "tenant_id", ""),
                    exc,
                )
                raise
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
