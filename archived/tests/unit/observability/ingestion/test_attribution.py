"""Tests for Attribution dataclass."""

from eden.observability.ingestion.attribution import Attribution


def test_default_attribution():
    a = Attribution(tenant_id="org_abc")
    assert a.tenant_id == "org_abc"
    assert a.project_id == "default"
    assert a.source_format == "webhook"
    assert a.user_id is None
    assert a.api_key_id is None
    assert a.auth_method == "api_key"
    assert a.client_ip is None


def test_with_source_format_returns_copy():
    a = Attribution(tenant_id="org_abc", source_format="otel")
    b = a.with_source_format("helicone")
    assert a.source_format == "otel"  # original unchanged
    assert b.source_format == "helicone"
    assert b.tenant_id == a.tenant_id
    assert b.project_id == a.project_id


def test_all_fields_round_trip():
    a = Attribution(
        tenant_id="org_xyz",
        project_id="proj_42",
        source_format="langfuse",
        user_id="user_1",
        api_key_id="key_2",
        auth_method="cookie",
        client_ip="10.0.0.1",
    )
    assert a.tenant_id == "org_xyz"
    assert a.project_id == "proj_42"
    assert a.source_format == "langfuse"
    assert a.user_id == "user_1"
    assert a.api_key_id == "key_2"
    assert a.auth_method == "cookie"
    assert a.client_ip == "10.0.0.1"
