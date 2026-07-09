"""F66 — Defensive PII redaction in auth.py.

F65 introduced ``eden.api.utils.redact``. F66 applies it to
the remaining PII-in-logs call sites in auth.py:

* ``signup honeypot triggered from ip=... email=...`` —
  was logging the requester's plaintext email AND IP.
  The IP is needed for the honeypot diagnostic (so the
  operator can block the bot), but the email is straight
  PII and must be redacted.
* ``verification email dispatch failed: {exc}`` /
  ``password reset email dispatch failed: {exc}`` /
  ``forgot-password dispatch failed: {exc}`` — the
  upstream ``exc`` in the email service can include the
  request email in the error message. F66 wraps the
  ``{exc}`` through ``redact_email`` defensively so
  even a buggy upstream service can't leak the email
  into our log stream.

This test pins the redaction at the source level so a
future refactor can't quietly re-introduce the leak.
"""

from __future__ import annotations

import inspect

import pytest

from eden.api.utils.redact import redact_email


class TestF66AuthHoneypotRedaction:
    """The signup honeypot log line MUST redact the email
    but keep the IP (which is the diagnostic)."""

    def test_honeypot_log_redacts_email(self) -> None:
        from eden.api.routes import auth

        src = inspect.getsource(auth)
        # The honeypot log must call ``redact_email`` on
        # ``request.email`` so the operator sees the IP
        # but not the address.
        assert "redact_email(request.email)" in src, (
            "F66 regression: signup honeypot log no longer "
            "redacts the requester's email"
        )
        # Negative pin: the unredacted form MUST NOT be
        # in the source. We use a small substring to
        # match the original line.
        assert '"signup honeypot triggered from ip=%s email=%s",\n            _client_ip(req),\n            request.email,' not in src, (
            "F66 regression: signup honeypot is logging "
            "the plaintext email again"
        )


class TestF66AuthDispatchExcRedaction:
    """The email-dispatch error logs MUST run the upstream
    ``exc`` through ``redact_email`` so a buggy upstream
    can't leak the request email into our log stream."""

    @pytest.mark.parametrize(
        "log_text",
        [
            "verification email dispatch failed",
            "password reset email dispatch failed",
            "forgot-password dispatch failed",
        ],
    )
    def test_dispatch_exc_is_redacted(self, log_text: str) -> None:
        from eden.api.routes import auth

        src = inspect.getsource(auth)
        # Each of the three error log lines MUST be
        # wrapped through ``redact_email(str(exc))`` (or
        # ``redact_all``). Find the log line by the
        # human-readable prefix.
        prefix_idx = src.find(log_text)
        assert prefix_idx != -1, (
            f"F66 test setup error: '{log_text}' not "
            "found in auth.py source"
        )
        # Look at the surrounding line — it should
        # contain ``redact_email(`` (or ``redact_all(``).
        # We pick a 200-char window centered on the
        # prefix.
        window = src[max(0, prefix_idx - 50): prefix_idx + 250]
        assert "redact_email(str(exc))" in window or "redact_all(" in window, (
            f"F66 regression: '{log_text}' log line no "
            "longer runs the upstream exc through the "
            "redact helper. PII (request email) may leak "
            "if the upstream service echoes it in errors."
        )
        # Negative pin: the unredacted form MUST NOT
        # appear in the source. We check for the
        # f-string interpolation pattern that doesn't
        # include the redact helper.
        bad_marker = f"f\"{log_text}: {{exc}}\""
        assert bad_marker not in src, (
            f"F66 regression: '{log_text}' is logging "
            "the upstream exc as-is — request email may "
            "leak into the log stream"
        )


class TestF66AuthImportsRedact:
    """``auth.py`` MUST import the redact helper so the
    redaction helpers are available to the patched call
    sites. A refactor that moves the helper elsewhere
    must update this import AND the call sites together."""

    def test_auth_imports_redact_email(self) -> None:
        from eden.api.routes import auth

        src = inspect.getsource(auth)
        assert "from eden.api.utils.redact import" in src, (
            "F66 regression: auth.py no longer imports "
            "the redact helper"
        )
        # The specific helper we use MUST be imported.
        assert "redact_email" in src, (
            "F66 regression: auth.py no longer imports "
            "redact_email"
        )


class TestF66AuthRedactionIsIdempotent:
    """A redaction helper that depends on the email being
    present in the format string is fragile. F66 pins that
    the helpers are pure functions — running them on
    already-redacted text MUST be a no-op (idempotent)."""

    def test_redact_email_idempotent(self) -> None:
        once = redact_email("alice@example.com")
        twice = redact_email(once)
        assert once == twice

    def test_redact_email_does_not_redact_other_at_signs(self) -> None:
        # A bare ``foo@bar`` (no TLD) is NOT a valid email
        # and must NOT be touched. This guards against a
        # future helper over-redaction that eats code
        # snippets.
        assert redact_email("see foo@bar for details") == "see foo@bar for details"
