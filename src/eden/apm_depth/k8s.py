"""Cat 22 — K8s attribute enrichment (v1.4).

Per the appendix (`docs/observability-gap/22-apm-tracing-depth.md`
§8) the v1.4 ship wires the OTel ``k8sattributes`` processor
into the gateway tier so every Eden span carries K8s
infrastructure attributes:

* ``k8s.pod.name``
* ``k8s.namespace.name``
* ``k8s.container.name``
* ``k8s.node.name``
* ``k8s.cluster.name``
* ``k8s.deployment.name`` (when discoverable)

The competitive payoff: the customer's APM correlation
story (LLM span ↔ container ↔ host ↔ log) just works
without a separate OTel collector sidecar — Eden reads
the K8s attributes from the same places the OTel
collector reads them and stamps them onto the span
attributes JSONB.

The :class:`K8sEnricher` resolves K8s attributes from
**three** sources, in priority order:

1. **OTel collector resource attributes** (the most
   authoritative). A pod already running the OTel SDK
   sets ``k8s.pod.uid`` (and friends) on the
   ``Resource``. The OTel gRPC receiver surfaces them
   on the request metadata. The enricher lifts them
   from the span's ``resource.attributes`` and stamps
   them onto ``attributes``.

2. **Kubernetes Downward API env vars** (the in-pod
   fallback). The Downward API exposes pod info via
   ``env`` keys (``MY_POD_NAME``, ``MY_POD_NAMESPACE``,
   ``MY_NODE_NAME``). The enricher reads the standard
   names: ``HOSTNAME``, ``KUBERNETES_NAMESPACE``,
   ``KUBERNETES_POD_NAME``, ``KUBERNETES_NODE_NAME``,
   ``KUBERNETES_SERVICE_HOST`` (for the cluster name).

3. **Service-account token parse** (the most expensive
   — only used when the Downward API is empty). The
   SA JWT contains the pod's namespace and service-
   account name; the enricher verifies the signature
   via the K8s API server's well-known JWKS. The v0
   ship does not implement the JWKS verify (it would
   need an HTTP client + retry policy); it surfaces the
   raw JWT claims (``namespace``, ``sa_name``) for the
   portal to render.

**Failure mode (per the doc).** If the SA token is
unavailable, the enricher falls back to a "best-effort
from Downward API" path. If the Downward API is also
empty, the enricher returns an empty enrichment (the
span is still stored, just without K8s attributes).

The enricher is exposed as a service so the portal
can run it on already-stored spans (when the customer
upgrades from non-K8s to K8s and wants historical
data to appear in the K8s dashboards).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

from ._common import _now_iso, _ok_envelope

logger = logging.getLogger(__name__)


# ─── K8s attribute names (the OTel semconv constant) ───────────────

#: The OTel K8s semantic-convention attribute names
#: (https://opentelemetry.io/docs/specs/semconv/resource/k8s/).
#: The v1.4 ship writes these onto every enriched span.
K8S_ATTR_NAMES: tuple[str, ...] = (
    "k8s.pod.name",
    "k8s.pod.uid",
    "k8s.namespace.name",
    "k8s.container.name",
    "k8s.node.name",
    "k8s.cluster.name",
    "k8s.deployment.name",
    "k8s.replicaset.name",
    "k8s.statefulset.name",
    "k8s.daemonset.name",
    "k8s.job.name",
    "k8s.cronjob.name",
    "k8s.service.name",
    "k8s.service.namespace",
)


# ─── Downward API env-var resolution ──────────────────────────────

#: The standard K8s Downward API env-var names Eden reads.
#: The "fallback" suffix means Eden accepts both the
#: official OTel names and the platform-agnostic
#: ``MY_POD_NAME`` / ``MY_POD_NAMESPACE`` conventions
#: the docs use.
DOWNWARD_API_ENV: dict[str, tuple[str, ...]] = {
    "k8s.pod.name": ("KUBERNETES_POD_NAME", "MY_POD_NAME", "HOSTNAME"),
    "k8s.pod.ip": ("KUBERNETES_POD_IP", "MY_POD_IP", "POD_IP"),
    "k8s.namespace.name": (
        "KUBERNETES_NAMESPACE",
        "MY_POD_NAMESPACE",
        "POD_NAMESPACE",
    ),
    "k8s.node.name": ("KUBERNETES_NODE_NAME", "MY_NODE_NAME", "NODE_NAME"),
    "k8s.container.name": (
        "KUBERNETES_CONTAINER_NAME",
        "MY_CONTAINER_NAME",
        "CONTAINER_NAME",
    ),
    "k8s.cluster.name": ("KUBERNETES_CLUSTER_NAME", "MY_CLUSTER_NAME", "CLUSTER_NAME"),
    "k8s.deployment.name": (
        "KUBERNETES_DEPLOYMENT_NAME",
        "MY_DEPLOYMENT_NAME",
        "DEPLOYMENT_NAME",
    ),
    "k8s.service.name": (
        "KUBERNETES_SERVICE_NAME",
        "MY_SERVICE_NAME",
        "SERVICE_NAME",
    ),
    "k8s.service.namespace": (
        "KUBERNETES_SERVICE_NAMESPACE",
        "MY_SERVICE_NAMESPACE",
    ),
}


#: The cluster-name heuristic. The K8s API server's
#: service-host DNS is ``<svc>.<ns>.svc.<cluster-domain>``;
#: Eden reads ``KUBERNETES_CLUSTER_NAME`` first (the
#: explicit env var), and falls back to a parse of
#: ``KUBERNETES_SERVICE_HOST`` that extracts the
#: suffix. The v0 ship returns ``""`` when neither is
#: set (the enricher treats that as "unknown cluster").
#: The OTel K8s processor does the same parse — see
#: https://github.com/open-telemetry/opentelemetry-collector-contrib
#: /blob/main/processor/k8sattributesprocessor/README.md
_CLUSTER_HOST_RE = re.compile(r"^[^.]+\.[^.]+\.svc\.([^.]+(?:\.[^.]+)?)\.?$")


# ─── Service-account JWT parse (lightweight) ───────────────────────


@dataclass(frozen=True)
class ServiceAccountClaims:
    """The relevant fields of a K8s service-account JWT.

    The v0 ship only extracts ``namespace`` and
    ``service_account_name`` (the two fields Eden
    surfaces onto the span). The full claim set is kept
    on the dataclass for the v1.4.1 follow-up that adds
    JWKS verification.
    """

    namespace: str = ""
    service_account_name: str = ""
    issuer: str = ""
    subject: str = ""
    raw_claims: dict[str, Any] = field(default_factory=dict)


def _b64url_decode(data: str) -> bytes:
    """Decode a base64url string (no padding)."""
    if not data:
        return b""
    s = str(data)
    # Add padding
    s += "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode("utf-8"))


def parse_service_account_jwt(token: str) -> ServiceAccountClaims:
    """Best-effort parse of a K8s service-account JWT.

    Returns :class:`ServiceAccountClaims` with empty
    fields if the token is malformed. The v0 ship does
    not verify the signature (the portal is responsible
    for surfacing "unverified" badges).

    K8s JWT claim shape (per the K8s docs)::

        {
          "iss": "https://kubernetes.default.svc.cluster.local",
          "kubernetes.io/serviceaccount/namespace": "default",
          "kubernetes.io/serviceaccount/secret.name": "...",
          "kubernetes.io/serviceaccount/service-account.name": "default",
          "sub": "system:serviceaccount:default:default",
          ...
        }
    """
    if not isinstance(token, str) or not token:
        return ServiceAccountClaims()
    parts = token.split(".")
    if len(parts) < 2:
        return ServiceAccountClaims()
    try:
        payload_bytes = _b64url_decode(parts[1])
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception as exc:
        logger.debug("sa_jwt: failed to decode payload: %s", exc)
        return ServiceAccountClaims()
    if not isinstance(payload, dict):
        return ServiceAccountClaims()
    return ServiceAccountClaims(
        namespace=str(payload.get("kubernetes.io/serviceaccount/namespace") or ""),
        service_account_name=str(
            payload.get("kubernetes.io/serviceaccount/service-account.name") or ""
        ),
        issuer=str(payload.get("iss") or ""),
        subject=str(payload.get("sub") or ""),
        raw_claims=payload,
    )


# ─── The enricher ───────────────────────────────────────────────────


class K8sEnricher:
    """The K8s attribute enricher.

    Resolves K8s attributes from (1) the OTel resource
    attributes (authoritative), (2) the K8s Downward API
    env vars (in-pod fallback), (3) the service-account
    JWT (last resort). Stamps the resolved set onto the
    span's ``attributes`` dict.
    """

    name = "k8s_enricher"

    def __init__(
        self,
        *,
        sa_token_path: str = "/var/run/secrets/kubernetes.io/serviceaccount/token",
        downward_env: dict[str, tuple[str, ...]] | None = None,
        enable_sa_jwt: bool = True,
    ) -> None:
        self.sa_token_path = str(
            sa_token_path
            or "/var/run/secrets/kubernetes.io/serviceaccount/token"
        )
        self.downward_env = downward_env or DOWNWARD_API_ENV
        self.enable_sa_jwt = bool(enable_sa_jwt)

    # ── Source 1: OTel resource attributes ────────────────────

    def _from_resource_attributes(
        self, resource_attrs: dict[str, Any] | None
    ) -> dict[str, str]:
        out: dict[str, str] = {}
        if not isinstance(resource_attrs, dict):
            return out
        for name in K8S_ATTR_NAMES:
            v = resource_attrs.get(name)
            if v is None:
                continue
            s = str(v).strip()
            if s:
                out[name] = s
        return out

    # ── Source 2: Downward API env vars ────────────────────────

    def _from_downward_api(
        self, env: dict[str, str] | None = None
    ) -> dict[str, str]:
        out: dict[str, str] = {}
        source = env if env is not None else os.environ
        if not isinstance(source, dict):
            return out
        for attr, env_names in self.downward_env.items():
            for env_name in env_names:
                v = source.get(env_name)
                if v is None:
                    continue
                s = str(v).strip()
                if s:
                    out[attr] = s
                    break
        # Cluster-name fallback: parse KUBERNETES_SERVICE_HOST
        if "k8s.cluster.name" not in out:
            host = source.get("KUBERNETES_SERVICE_HOST") or ""
            m = _CLUSTER_HOST_RE.match(host)
            if m:
                out["k8s.cluster.name"] = m.group(1)
        return out

    # ── Source 3: service-account JWT ──────────────────────────

    def _from_service_account(self) -> tuple[dict[str, str], ServiceAccountClaims | None]:
        if not self.enable_sa_jwt:
            return {}, None
        try:
            with open(self.sa_token_path, encoding="utf-8") as f:
                token = f.read().strip()
        except (FileNotFoundError, OSError, PermissionError):
            return {}, None
        if not token:
            return {}, None
        claims = parse_service_account_jwt(token)
        out: dict[str, str] = {}
        if claims.namespace:
            out["k8s.namespace.name"] = claims.namespace
        if claims.service_account_name:
            out["k8s.service.name"] = claims.service_account_name
        if claims.issuer:
            # Issuer is a URL like
            # ``https://kubernetes.default.svc.cluster.local``;
            # the cluster name is the second component of
            # the host.
            try:
                from urllib.parse import urlparse

                host = urlparse(claims.issuer).hostname or ""
                # ``kubernetes.default.svc.cluster.local``
                parts = host.split(".")
                if len(parts) >= 4 and parts[-2:] == ["svc", "cluster"]:
                    out["k8s.cluster.name"] = parts[-3]
            except Exception:
                pass
        return out, claims

    # ── Public surface ─────────────────────────────────────────

    def enrich(
        self,
        org_id: str,
        *,
        attributes: dict[str, Any],
        resource_attributes: dict[str, Any] | None = None,
        env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Enrich a span's attributes with K8s info.

        Returns the live ``ok`` envelope with
        ``data: {"attributes": {...}, "k8s": {...},
        "sources": ["resource"|"downward"|"sa_jwt"],
        "fallback_used": bool}``.

        The merged set is written into ``attributes``
        (in place — but the original dict is also
        returned so callers can compare). The merge is
        additive: existing keys are NOT overwritten,
        which matches the rest of the v1.4 dual-emit
        pattern (the customer-supplied name wins).
        """
        merged = dict(attributes or {})
        k8s_resolved: dict[str, str] = {}
        sources: list[str] = []

        # 1. Resource attributes
        from_resource = self._from_resource_attributes(resource_attributes)
        if from_resource:
            sources.append("resource")
            for k, v in from_resource.items():
                k8s_resolved.setdefault(k, v)

        # 2. Downward API env
        from_env = self._from_downward_api(env)
        if from_env:
            sources.append("downward")
            for k, v in from_env.items():
                k8s_resolved.setdefault(k, v)

        # 3. SA JWT (last resort)
        from_sa, claims = self._from_service_account()
        if from_sa:
            sources.append("sa_jwt")
            for k, v in from_sa.items():
                k8s_resolved.setdefault(k, v)

        fallback_used = bool(
            from_env and "k8s.cluster.name" not in k8s_resolved and "sa_jwt" in sources
        )

        # Stamp onto the merged attributes
        for k, v in k8s_resolved.items():
            if k not in merged:
                merged[k] = v

        return _ok_envelope(
            self.name,
            {
                "attributes": merged,
                "k8s": k8s_resolved,
                "sources": sources,
                "fallback_used": fallback_used,
                "sa_claims": (
                    {
                        "namespace": claims.namespace,
                        "service_account_name": claims.service_account_name,
                        "issuer": claims.issuer,
                    }
                    if claims is not None
                    else None
                ),
                "enriched_at": _now_iso(),
            },
        )

    def enrich_batch(
        self,
        org_id: str,
        *,
        spans: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Enrich a batch of spans in one call.

        Returns the live ``ok`` envelope with
        ``data: {"spans": [...], "k8s_enriched_count": N}``.
        The ``resource_attributes`` on each span (if any)
        are read from ``span["resource"]["attributes"]`` —
        matches the OTel JSON shape.
        """
        enriched_count = 0
        out_spans: list[dict[str, Any]] = []
        for span in spans or []:
            if not isinstance(span, dict):
                out_spans.append(span)
                continue
            resource = span.get("resource") or {}
            resource_attrs = (
                resource.get("attributes") if isinstance(resource, dict) else None
            )
            attrs = span.get("attributes") or {}
            r = self.enrich(
                org_id,
                attributes=attrs,
                resource_attributes=resource_attrs,
            )
            data = r.get("data") or {}
            k8s = data.get("k8s") or {}
            if k8s:
                enriched_count += 1
            new_span = dict(span)
            new_span["attributes"] = data.get("attributes") or attrs
            new_span["apm.k8s"] = k8s
            out_spans.append(new_span)
        return _ok_envelope(
            self.name,
            {
                "spans": out_spans,
                "k8s_enriched_count": enriched_count,
                "enriched_at": _now_iso(),
            },
        )

    def detect(self, env: dict[str, str] | None = None) -> dict[str, Any]:
        """Detect whether this process is running in K8s.

        Returns the live ``ok`` envelope with
        ``data: {"is_k8s": bool, "sources": [...],
        "missing_attrs": [...]}``. The portal uses this
        to surface "K8s enrichment not active — install
        the OTel collector with the k8sattributes
        processor" hints.
        """
        source = env if env is not None else os.environ
        sources: list[str] = []
        missing: list[str] = []
        for attr, env_names in self.downward_env.items():
            if any(source.get(n) for n in env_names):
                sources.append(attr)
            else:
                missing.append(attr)
        # SA token existence
        sa_exists = False
        try:
            sa_exists = os.path.exists(self.sa_token_path)
        except OSError:
            sa_exists = False
        is_k8s = bool(sources) or sa_exists
        return _ok_envelope(
            "k8s_detect",
            {
                "is_k8s": is_k8s,
                "sources_present": sources,
                "missing_attrs": missing,
                "sa_token_present": sa_exists,
                "checked_at": _now_iso(),
            },
        )
