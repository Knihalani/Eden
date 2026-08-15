"""F65 — PII redaction helper tests.

The pre-F65 codebase had several ``logger.info(f"... {email}")``
and ``logger.error(f"... {bearer xxx} ...")`` call sites that
wrote plaintext PII to the log stream. F65 introduces a
``redact`` helper module under
``eden.api.utils.redact`` and applies it to:

* ``services.email_service.py`` — recipient email was logged
  in 4 places (success, failure, timeout, request error),
  plus the entire email body in the stub-mode log.
* ``api.routes.compliance.do_not_sell`` — the CCPA endpoint
  is public (the requester is by definition unauthenticated)
  so logging the plaintext email put unauthenticated user
  data in the log stream. That's a PII-in-logs violation
  under both GDPR Art. 5 (data minimisation) and CCPA
  §1798.150.

This test pins the helper module's behaviour so a future
refactor can't quietly regress the redaction.
"""

from __future__ import annotations

import pytest

from eden.api.utils.redact import (
    redact_all,
    redact_credentials,
    redact_email,
)


class TestF65RedactEmail:
    """``redact_email`` replaces every email address in the
    input string with ``***``."""

    def test_redacts_simple_email(self) -> None:
        assert redact_email("Email sent to alice@example.com") == "Email sent to ***"

    def test_redacts_subdomain_email(self) -> None:
        assert (
            redact_email("user@sub.example.com did not authenticate")
            == "*** did not authenticate"
        )

    def test_redacts_multiple_emails(self) -> None:
        assert (
            redact_email("from alice@a.com to bob@b.com")
            == "from *** to ***"
        )

    def test_preserves_non_email_text(self) -> None:
        assert redact_email("no email here") == "no email here"

    def test_empty_string(self) -> None:
        assert redact_email("") == ""

    def test_does_not_match_at_sign_alone(self) -> None:
        # A bare "foo@bar" without a TLD shouldn't match
        # the email regex — avoids false positives in code
        # snippets like "func@module" decorators.
        assert redact_email("func@module") == "func@module"

    def test_preserves_text_around_email(self) -> None:
        out = redact_email("Subject: hello\nTo: alice@example.com\nDone")
        assert "alice@example.com" not in out
        assert "Subject: hello" in out
        assert "Done" in out


class TestF65RedactCredentials:
    """``redact_credentials`` masks bearer tokens + token-shaped
    KV pairs."""

    def test_redacts_bearer_token(self) -> None:
        assert redact_credentials("bearer abc123def456ghi789") == "bearer ***"

    def test_redacts_bearer_token_capitalised(self) -> None:
        assert redact_credentials("Bearer sk-live-abcdef12345") == "Bearer ***"

    def test_redacts_token_kv(self) -> None:
        assert redact_credentials("token=sk-live-abcdef") == "token=***"

    def test_redacts_api_key_kv(self) -> None:
        assert redact_credentials("api_key=my-secret-1234") == "api_key=***"

    def test_redacts_authorization(self) -> None:
        assert (
            redact_credentials("authorization=Basic dXNlcjpwYXNz")
            == "authorization=***"
        )

    def test_preserves_short_kv(self) -> None:
        # Tokens shorter than 6 chars are NOT redacted —
        # they're more likely to be non-sensitive config
        # values like ``page=1``.
        assert redact_credentials("page=5") == "page=5"

    def test_preserves_non_credential_text(self) -> None:
        assert redact_credentials("hello world") == "hello world"

    def test_fast_path_skips_clean_strings(self) -> None:
        # No probe markers → identity (no regex rewrite).
        clean = "upstream timeout after 30s status=502"
        assert redact_credentials(clean) is clean
        assert redact_all(clean) is clean
        assert redact_email("no email here") == "no email here"


class TestF65RedactAll:
    """``redact_all`` combines both redactions."""

    def test_redacts_email_and_token(self) -> None:
        out = redact_all("email=alice@example.com with token=sk-live-abcdef")
        assert "alice@example.com" not in out
        assert "sk-live-abcdef" not in out
        assert "email=***" in out
        assert "token=***" in out

    def test_idempotent(self) -> None:
        once = redact_all("alice@example.com")
        twice = redact_all(once)
        assert once == twice

    def test_empty_string(self) -> None:
        assert redact_all("") == ""


class TestF65SourceLevel:
    """Source-level pin: the F65 helpers exist at the
    documented import path and are used in the two patched
    call sites. A future refactor that moves the helpers or
    drops the import must update the audit log AND the
    test, not just one."""

    def test_redact_module_importable(self) -> None:
        # The import path is part of the public surface
        # documented in FIXES_LOG.md.
        from eden.api.utils import redact  # noqa: F401

        assert hasattr(redact, "redact_email")
        assert hasattr(redact, "redact_credentials")
        assert hasattr(redact, "redact_all")

    def test_email_service_imports_redact(self) -> None:
        import inspect

        from eden.services import email_service

        src = inspect.getsource(email_service)
        # The patched module MUST use ``redact_email`` for
        # the body content redaction. We pin the import
        # path; if a refactor moves the module, this
        # assertion will catch the regression.
        assert "from eden.api.utils.redact import" in src, (
            "F65 regression: email_service.py no longer "
            "imports the redact helpers"
        )
        assert "redact_email" in src, (
            "F65 regression: email_service.py no longer "
            "calls redact_email on the email body"
        )

    def test_compliance_redacts_email_in_log(self) -> None:
        import inspect

        from eden.api.routes import compliance

        src = inspect.getsource(compliance)
        # The CCPA endpoint MUST NOT log the plaintext
        # email. We pin the redaction in the source.
        assert "compliance.do_not_sell" in src
        assert "email=***" in src or "***@" in src, (
            "F65 regression: compliance.do_not_sell no "
            "longer redacts the email address before "
            "logging"
        )
        # Negative pin: the log statement MUST NOT contain
        # a direct ``%s`` placeholder for the email
        # variable (which would re-introduce the PII
        # leak).
        assert (
            '"compliance.do_not_sell: email=%s", body.email' not in src
        ), (
            "F65 regression: compliance.do_not_sell "
            "is logging the plaintext email again"
        )
