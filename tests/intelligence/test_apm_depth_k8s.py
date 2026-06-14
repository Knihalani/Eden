"""Behavioural tests for Cat 22 v1.4.1 — K8s attribute enrichment.

Exercises :mod:`eden.apm_depth.k8s`:

* :func:`parse_service_account_jwt` — JWT claim extraction
* :class:`K8sEnricher` — the 3 source merge (resource
  attributes / Downward API / SA JWT) + the additive
  stamp-on-attributes behaviour
* :meth:`K8sEnricher.enrich_batch` — batch path
* :meth:`K8sEnricher.detect` — is-this-process-K8s check
"""

from __future__ import annotations

import base64
import json

# ─── ServiceAccount JWT parse ────────────────────────────────────


def _make_jwt(payload: dict) -> str:
    """Build a fake JWT (header.payload.<no-sig>)."""
    def b64(d: dict) -> str:
        raw = json.dumps(d).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("utf-8")

    header = b64({"alg": "RS256", "kid": "test"})
    body = b64(payload)
    return f"{header}.{body}.fakesig"


class TestParseServiceAccountJwt:
    def test_extracts_namespace_and_sa_name(self) -> None:
        from eden.apm_depth import parse_service_account_jwt

        token = _make_jwt(
            {
                "iss": "https://kubernetes.default.svc.cluster.local",
                "sub": "system:serviceaccount:default:default",
                "kubernetes.io/serviceaccount/namespace": "default",
                "kubernetes.io/serviceaccount/service-account.name": "default",
            }
        )
        claims = parse_service_account_jwt(token)
        assert claims.namespace == "default"
        assert claims.service_account_name == "default"
        assert (
            claims.issuer
            == "https://kubernetes.default.svc.cluster.local"
        )
        assert claims.subject == "system:serviceaccount:default:default"

    def test_empty_token(self) -> None:
        from eden.apm_depth import parse_service_account_jwt

        assert parse_service_account_jwt("").namespace == ""
        assert parse_service_account_jwt(None).namespace == ""  # type: ignore[arg-type]

    def test_malformed_token(self) -> None:
        from eden.apm_depth import parse_service_account_jwt

        # Only one segment
        assert parse_service_account_jwt("bad-token").namespace == ""
        # Three segments but bad base64
        assert parse_service_account_jwt("aaa.bbb.ccc").namespace == ""

    def test_keeps_raw_claims(self) -> None:
        from eden.apm_depth import parse_service_account_jwt

        token = _make_jwt(
            {
                "kubernetes.io/serviceaccount/namespace": "ns1",
                "extra": "value",
            }
        )
        claims = parse_service_account_jwt(token)
        assert claims.raw_claims.get("extra") == "value"


# ─── K8sEnricher — Downward API path ──────────────────────────────


class TestK8sEnricherDownwardApi:
    def test_resolves_from_env(self) -> None:
        from eden.apm_depth import K8sEnricher

        env = {
            "KUBERNETES_POD_NAME": "my-pod-abc123",
            "KUBERNETES_NAMESPACE": "eden-prod",
            "KUBERNETES_NODE_NAME": "ip-10-0-0-1",
            "KUBERNETES_CONTAINER_NAME": "api",
        }
        r = K8sEnricher(enable_sa_jwt=False).enrich(
            "org_t",
            attributes={"service.name": "eden-api"},
            env=env,
        )
        d = r["data"]
        assert d["k8s"]["k8s.pod.name"] == "my-pod-abc123"
        assert d["k8s"]["k8s.namespace.name"] == "eden-prod"
        assert d["k8s"]["k8s.node.name"] == "ip-10-0-0-1"
        assert d["k8s"]["k8s.container.name"] == "api"
        # Stamped onto the returned attributes
        assert d["attributes"]["k8s.pod.name"] == "my-pod-abc123"
        # Sources only contain ``downward``
        assert "downward" in d["sources"]

    def test_accepts_alternate_env_names(self) -> None:
        from eden.apm_depth import K8sEnricher

        env = {
            "MY_POD_NAME": "alt-pod",
            "MY_POD_NAMESPACE": "alt-ns",
            "MY_NODE_NAME": "alt-node",
        }
        r = K8sEnricher(enable_sa_jwt=False).enrich(
            "org_t", attributes={}, env=env
        )
        d = r["data"]
        assert d["k8s"]["k8s.pod.name"] == "alt-pod"
        assert d["k8s"]["k8s.namespace.name"] == "alt-ns"
        assert d["k8s"]["k8s.node.name"] == "alt-node"

    def test_does_not_overwrite_existing(self) -> None:
        from eden.apm_depth import K8sEnricher

        env = {"KUBERNETES_POD_NAME": "env-pod"}
        r = K8sEnricher(enable_sa_jwt=False).enrich(
            "org_t",
            attributes={"k8s.pod.name": "user-pod"},
            env=env,
        )
        d = r["data"]
        # The existing value wins
        assert d["attributes"]["k8s.pod.name"] == "user-pod"
        # But the resolved set still has the env value
        assert d["k8s"]["k8s.pod.name"] == "env-pod"

    def test_cluster_name_from_service_host(self) -> None:
        from eden.apm_depth import K8sEnricher

        env = {
            "KUBERNETES_POD_NAME": "p",
            "KUBERNETES_SERVICE_HOST": "kubernetes.default.svc.cluster.local",
        }
        r = K8sEnricher(enable_sa_jwt=False).enrich(
            "org_t", attributes={}, env=env
        )
        # The service-host heuristic extracts the
        # cluster-local suffix.
        assert r["data"]["k8s"]["k8s.cluster.name"] == "cluster.local"


# ─── K8sEnricher — resource attributes path ───────────────────────


class TestK8sEnricherResourceAttrs:
    def test_resolves_from_resource(self) -> None:
        from eden.apm_depth import K8sEnricher

        resource = {
            "k8s.pod.name": "resource-pod",
            "k8s.namespace.name": "resource-ns",
            "k8s.deployment.name": "eden-api",
        }
        r = K8sEnricher(enable_sa_jwt=False).enrich(
            "org_t",
            attributes={},
            resource_attributes=resource,
        )
        d = r["data"]
        assert d["k8s"]["k8s.pod.name"] == "resource-pod"
        assert d["k8s"]["k8s.deployment.name"] == "eden-api"
        assert "resource" in d["sources"]

    def test_resource_wins_over_env(self) -> None:
        from eden.apm_depth import K8sEnricher

        resource = {"k8s.pod.name": "from-resource"}
        env = {"KUBERNETES_POD_NAME": "from-env"}
        r = K8sEnricher(enable_sa_jwt=False).enrich(
            "org_t",
            attributes={},
            resource_attributes=resource,
            env=env,
        )
        # setdefault means resource wins (it's processed first)
        assert r["data"]["k8s"]["k8s.pod.name"] == "from-resource"
        assert set(r["data"]["sources"]) == {"resource", "downward"}


# ─── K8sEnricher — edge cases ─────────────────────────────────────


class TestK8sEnricherEdgeCases:
    def test_handles_empty_inputs(self) -> None:
        from eden.apm_depth import K8sEnricher

        r = K8sEnricher(enable_sa_jwt=False).enrich("org_t", attributes={})
        assert r["data"]["k8s"] == {}
        assert r["data"]["sources"] == []
        assert r["data"]["fallback_used"] is False

    def test_handles_non_dict_attributes(self) -> None:
        from eden.apm_depth import K8sEnricher

        r = K8sEnricher(enable_sa_jwt=False).enrich(
            "org_t", attributes=None  # type: ignore[arg-type]
        )
        assert r["status"] == "ok"
        assert r["data"]["k8s"] == {}

    def test_enrich_batch(self) -> None:
        from eden.apm_depth import K8sEnricher

        spans = [
            {
                "name": "span-1",
                "resource": {
                    "attributes": {"k8s.pod.name": "p1"},
                },
                "attributes": {"foo": "bar"},
            },
            {
                "name": "span-2",
                "resource": {
                    "attributes": {"k8s.pod.name": "p2"},
                },
                "attributes": {"baz": "qux"},
            },
        ]
        r = K8sEnricher(enable_sa_jwt=False).enrich_batch(
            "org_t", spans=spans
        )
        assert r["data"]["k8s_enriched_count"] == 2
        assert r["data"]["spans"][0]["apm.k8s"]["k8s.pod.name"] == "p1"
        assert r["data"]["spans"][1]["apm.k8s"]["k8s.pod.name"] == "p2"

    def test_enrich_batch_skips_non_dict_spans(self) -> None:
        from eden.apm_depth import K8sEnricher

        spans = [None, "bad", {"attributes": {}}]  # type: ignore[list-item]
        r = K8sEnricher(enable_sa_jwt=False).enrich_batch(
            "org_t", spans=spans  # type: ignore[arg-type]
        )
        assert r["data"]["k8s_enriched_count"] == 0


# ─── K8sEnricher.detect ──────────────────────────────────────────


class TestK8sDetect:
    def test_detects_when_env_present(self) -> None:
        from eden.apm_depth import K8sEnricher

        env = {
            "KUBERNETES_POD_NAME": "p",
            "KUBERNETES_NAMESPACE": "n",
        }
        r = K8sEnricher(enable_sa_jwt=False).detect(env=env)
        assert r["data"]["is_k8s"] is True
        assert "k8s.pod.name" in r["data"]["sources_present"]
        assert "k8s.namespace.name" in r["data"]["sources_present"]
        assert "k8s.node.name" in r["data"]["missing_attrs"]

    def test_detects_false_when_empty(self) -> None:
        from eden.apm_depth import K8sEnricher

        r = K8sEnricher(
            enable_sa_jwt=False,
            sa_token_path="/nonexistent/path",
        ).detect(env={})
        assert r["data"]["is_k8s"] is False
        assert r["data"]["sa_token_present"] is False
        assert r["data"]["sources_present"] == []
