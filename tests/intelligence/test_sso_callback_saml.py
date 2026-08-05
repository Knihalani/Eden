"""FEAT-1: hand-rolled SAML assertion validation in ``sso_callback``.

These tests build a real, RSA-signed SAML 2.0 ``<Assertion>`` (using
the same primitives — ``xml.etree.ElementTree.canonicalize`` +
``cryptography`` — that ``eden.api.routes.sso._validate_saml_assertion``
verifies with) and confirm the callback: mints a session on a
genuinely valid signature, and rejects a tampered assertion / wrong
signing key / expired assertion with an honest 401 — never the old
"sso_not_enabled" 503.

See ``_validate_saml_assertion``'s docstring in ``sso.py`` for the
explicitly-documented scope/gaps of this hand-rolled verifier (no
AudienceRestriction/InResponseTo check, RSA-only, single
enveloped-signature-on-Assertion only).
"""

from __future__ import annotations

import base64
import copy
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding as rsa_padding
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi import FastAPI
from fastapi.testclient import TestClient

ORG = "org-1"
PROVIDER_ID = "prov-1"

_NS = {
    "saml": "urn:oasis:names:tc:SAML:2.0:assertion",
    "ds": "http://www.w3.org/2000/09/xmldsig#",
}
ET.register_namespace("saml", _NS["saml"])
ET.register_namespace("ds", _NS["ds"])


def _rsa_keypair_and_cert() -> tuple[Any, str]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "test-idp.example.com")]
    )
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(days=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=365))
        .sign(private_key, hashes.SHA256())
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode("ascii")
    return private_key, cert_pem


def _build_unsigned_assertion(
    assertion_id: str,
    email: str,
    not_before: datetime,
    not_on_or_after: datetime,
) -> ET.Element:
    nb = not_before.strftime("%Y-%m-%dT%H:%M:%SZ")
    noa = not_on_or_after.strftime("%Y-%m-%dT%H:%M:%SZ")
    xml = f"""
    <saml:Assertion xmlns:saml="{_NS['saml']}" ID="{assertion_id}" Version="2.0">
      <saml:Issuer>https://test-idp.example.com</saml:Issuer>
      <saml:Subject>
        <saml:NameID>{email}</saml:NameID>
      </saml:Subject>
      <saml:Conditions NotBefore="{nb}" NotOnOrAfter="{noa}"/>
      <saml:AttributeStatement>
        <saml:Attribute Name="name">
          <saml:AttributeValue>Test User</saml:AttributeValue>
        </saml:Attribute>
      </saml:AttributeStatement>
    </saml:Assertion>
    """.strip()
    return ET.fromstring(xml)


def _sign_assertion(assertion: ET.Element, assertion_id: str, private_key: Any) -> ET.Element:
    """Compute a real enveloped XML-DSig signature over ``assertion``
    and attach it as a ``<ds:Signature>`` child — mirroring exactly
    what ``_verify_saml_signature`` expects to find.
    """
    canonical_assertion = ET.canonicalize(ET.tostring(assertion, encoding="unicode"))
    digest = hashes.Hash(hashes.SHA256())
    digest.update(canonical_assertion.encode("utf-8"))
    digest_value = base64.b64encode(digest.finalize()).decode("ascii")

    ds = _NS["ds"]
    signed_info_xml = f"""
    <ds:SignedInfo xmlns:ds="{ds}">
      <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>
      <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
      <ds:Reference URI="#{assertion_id}">
        <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
        <ds:DigestValue>{digest_value}</ds:DigestValue>
      </ds:Reference>
    </ds:SignedInfo>
    """.strip()
    signed_info_el = ET.fromstring(signed_info_xml)
    canonical_signed_info = ET.canonicalize(ET.tostring(signed_info_el, encoding="unicode"))
    signature = private_key.sign(
        canonical_signed_info.encode("utf-8"), rsa_padding.PKCS1v15(), hashes.SHA256()
    )
    signature_value = base64.b64encode(signature).decode("ascii")

    sig_xml = f"""
    <ds:Signature xmlns:ds="{ds}">
      {signed_info_xml}
      <ds:SignatureValue>{signature_value}</ds:SignatureValue>
    </ds:Signature>
    """.strip()
    sig_el = ET.fromstring(sig_xml)
    signed = copy.deepcopy(assertion)
    signed.append(sig_el)
    return signed


def _saml_response_b64(assertion: ET.Element) -> str:
    xml_bytes = ET.tostring(assertion, encoding="utf-8")
    return base64.b64encode(xml_bytes).decode("ascii")


def _provider_row(certificate: str | None) -> dict[str, Any]:
    return {
        "id": PROVIDER_ID,
        "org_id": ORG,
        "provider_type": "saml2",
        "name": "saml2",
        "client_id": None,
        "client_secret": None,
        "authorization_endpoint": "https://test-idp.example.com/sso",
        "token_endpoint": None,
        "userinfo_endpoint": None,
        "certificate": certificate,
    }


def _pg_with_provider(certificate: str | None) -> MagicMock:
    pg = MagicMock()
    provider_row = _provider_row(certificate)
    users: dict[str, dict[str, Any]] = {}
    memberships: set[tuple[str, str]] = set()

    async def _fetchrow(query: str, *args: Any, **kwargs: Any):
        q = " ".join(query.split()).lower()
        if "from org_sso_settings" in q or "join sso_configurations" in q:
            return provider_row
        if "select id from users where email" in q:
            row = users.get(args[0])
            return {"id": row["id"]} if row else None
        if "update users" in q and "returning token_version" in q:
            return {"token_version": 1}
        if "select id, role from org_members" in q:
            if (args[0], args[1]) in memberships:
                return {"id": "member-1", "role": "member"}
            return None
        return None

    async def _execute(query: str, *args: Any, **kwargs: Any):
        q = " ".join(query.split()).lower()
        if "insert into users" in q:
            users[args[1]] = {"id": args[0], "email": args[1]}
            return "INSERT 0 1"
        if "insert into org_members" in q:
            memberships.add((args[0], args[1]))
            return "INSERT 0 1"
        return ""

    pg.fetchrow = AsyncMock(side_effect=_fetchrow)
    pg.fetch = AsyncMock(return_value=[])
    pg.execute = AsyncMock(side_effect=_execute)

    @asynccontextmanager
    async def _noop_transaction():
        yield pg

    pg.transaction = _noop_transaction
    return pg


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.store[key] = value

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def delete(self, key: str) -> int:
        return 1 if self.store.pop(key, None) is not None else 0


def _build_app_with_state() -> tuple[FastAPI, _FakeRedis]:
    from eden.api.routes import sso as sso_routes

    app = FastAPI()
    app.include_router(sso_routes.router)
    redis = _FakeRedis()
    redis.store["eden:sso:state:valid-state"] = f"{PROVIDER_ID}|{ORG}"
    return app, redis


def test_saml_callback_success_with_valid_signature() -> None:
    private_key, cert_pem = _rsa_keypair_and_cert()
    now = datetime.now(UTC)
    unsigned = _build_unsigned_assertion(
        "assertion-1", "saml-user@example.com", now - timedelta(minutes=2), now + timedelta(minutes=10)
    )
    signed = _sign_assertion(unsigned, "assertion-1", private_key)
    saml_response = _saml_response_b64(signed)

    app, redis = _build_app_with_state()
    pg = _pg_with_provider(cert_pem)
    from eden.api.routes import sso as sso_routes

    with (
        patch.object(sso_routes, "get_redis_client", AsyncMock(return_value=redis)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
    ):
        client = TestClient(app)
        resp = client.post(
            f"/sso/callback/{PROVIDER_ID}",
            params={"org_id": ORG, "state": "valid-state", "saml_response": saml_response},
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["email"] == "saml-user@example.com"
    assert resp.cookies.get("authorization")


def test_saml_callback_rejects_signature_from_wrong_key() -> None:
    """Assertion signed with a DIFFERENT private key than the
    org's registered certificate must be rejected."""
    signing_key, _unused_cert = _rsa_keypair_and_cert()
    _registered_key, registered_cert_pem = _rsa_keypair_and_cert()
    now = datetime.now(UTC)
    unsigned = _build_unsigned_assertion(
        "assertion-2", "saml-user@example.com", now - timedelta(minutes=2), now + timedelta(minutes=10)
    )
    signed = _sign_assertion(unsigned, "assertion-2", signing_key)
    saml_response = _saml_response_b64(signed)

    app, redis = _build_app_with_state()
    pg = _pg_with_provider(registered_cert_pem)
    from eden.api.routes import sso as sso_routes

    with (
        patch.object(sso_routes, "get_redis_client", AsyncMock(return_value=redis)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
    ):
        client = TestClient(app)
        resp = client.post(
            f"/sso/callback/{PROVIDER_ID}",
            params={"org_id": ORG, "state": "valid-state", "saml_response": saml_response},
        )

    assert resp.status_code == 401, resp.text
    assert "sso_not_enabled" not in resp.text.lower()


def test_saml_callback_rejects_tampered_assertion() -> None:
    """A digest/signature computed over the original assertion must
    fail once the assertion body is mutated post-signing (e.g. an
    attacker swapping the NameID email)."""
    private_key, cert_pem = _rsa_keypair_and_cert()
    now = datetime.now(UTC)
    unsigned = _build_unsigned_assertion(
        "assertion-3", "victim@example.com", now - timedelta(minutes=2), now + timedelta(minutes=10)
    )
    signed = _sign_assertion(unsigned, "assertion-3", private_key)
    # Tamper: swap the NameID after signing.
    name_id = signed.find("saml:Subject/saml:NameID", _NS)
    assert name_id is not None
    name_id.text = "attacker@example.com"
    saml_response = _saml_response_b64(signed)

    app, redis = _build_app_with_state()
    pg = _pg_with_provider(cert_pem)
    from eden.api.routes import sso as sso_routes

    with (
        patch.object(sso_routes, "get_redis_client", AsyncMock(return_value=redis)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
    ):
        client = TestClient(app)
        resp = client.post(
            f"/sso/callback/{PROVIDER_ID}",
            params={"org_id": ORG, "state": "valid-state", "saml_response": saml_response},
        )

    assert resp.status_code == 401, resp.text


def test_saml_callback_rejects_expired_assertion() -> None:
    private_key, cert_pem = _rsa_keypair_and_cert()
    now = datetime.now(UTC)
    unsigned = _build_unsigned_assertion(
        "assertion-4",
        "saml-user@example.com",
        now - timedelta(hours=2),
        now - timedelta(hours=1),  # NotOnOrAfter well in the past
    )
    signed = _sign_assertion(unsigned, "assertion-4", private_key)
    saml_response = _saml_response_b64(signed)

    app, redis = _build_app_with_state()
    pg = _pg_with_provider(cert_pem)
    from eden.api.routes import sso as sso_routes

    with (
        patch.object(sso_routes, "get_redis_client", AsyncMock(return_value=redis)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
    ):
        client = TestClient(app)
        resp = client.post(
            f"/sso/callback/{PROVIDER_ID}",
            params={"org_id": ORG, "state": "valid-state", "saml_response": saml_response},
        )

    assert resp.status_code == 401, resp.text
    assert "expired" in resp.text.lower()


def test_saml_callback_rejects_missing_certificate() -> None:
    private_key, _cert_pem = _rsa_keypair_and_cert()
    now = datetime.now(UTC)
    unsigned = _build_unsigned_assertion(
        "assertion-5", "saml-user@example.com", now - timedelta(minutes=2), now + timedelta(minutes=10)
    )
    signed = _sign_assertion(unsigned, "assertion-5", private_key)
    saml_response = _saml_response_b64(signed)

    app, redis = _build_app_with_state()
    pg = _pg_with_provider(certificate=None)
    from eden.api.routes import sso as sso_routes

    with (
        patch.object(sso_routes, "get_redis_client", AsyncMock(return_value=redis)),
        patch.object(sso_routes, "get_postgres_client", AsyncMock(return_value=pg)),
    ):
        client = TestClient(app)
        resp = client.post(
            f"/sso/callback/{PROVIDER_ID}",
            params={"org_id": ORG, "state": "valid-state", "saml_response": saml_response},
        )

    assert resp.status_code == 503, resp.text
    assert "certificate" in resp.text.lower()
