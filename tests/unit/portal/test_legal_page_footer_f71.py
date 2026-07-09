"""F71 — Marketing footer with CCPA "Do Not Sell" link.

Per the prod-ready checklist §1.5: every marketing page MUST
surface the "Do Not Sell My Personal Information" link so
California residents can opt out. Pre-F71 the link was only on
the marketing homepage footer; the legal pages
(/privacy, /terms, /dpa, /security) used a ``LegalPage`` shell
that had no footer at all. F71 adds a shared marketing footer
to ``LegalPage`` with the Do Not Sell link.

This test pins the footer at the source level (no test runner
is set up for the portal yet) so a future refactor that
removes the link fails the test.
"""

from __future__ import annotations

import inspect
import re


def _get_legal_page_source() -> str:
    """Read the ``LegalPage`` component source for source-level pinning."""
    # The component lives in the portal; import lazily so the
    # backend test suite doesn't pull in the React tree.
    from pathlib import Path

    src = (
        Path(__file__).parent.parent.parent.parent
        / "clients"
        / "portal"
        / "src"
        / "components"
        / "layout"
        / "legal-page.tsx"
    )
    return src.read_text()


class TestF71LegalPageFooter:
    """The ``LegalPage`` shared shell MUST render a footer with
    the CCPA "Do Not Sell My Personal Information" link."""

    def test_legal_page_renders_a_footer_element(self) -> None:
        src = _get_legal_page_source()
        # A <footer> element MUST be present
        assert "<footer" in src, (
            "F71 regression: LegalPage no longer renders a <footer> element. "
            "Per the prod-ready checklist §1.5, every marketing page must "
            "have a footer with the CCPA Do Not Sell link."
        )

    def test_footer_includes_do_not_sell_link(self) -> None:
        src = _get_legal_page_source()
        # The footer MUST include a link to the CCPA do-not-sell endpoint
        # at the canonical path the backend exposes (compliance.do_not_sell).
        assert "/api/v1/me/do-not-sell" in src, (
            "F71 regression: LegalPage footer no longer includes the "
            "CCPA Do Not Sell link (pointing at /api/v1/me/do-not-sell)."
        )
        # The link text MUST match the CCPA-required wording
        # ("Do Not Sell My Personal Information" — but the UI
        # uses the shorter "Do Not Sell My Info" for line-length
        # reasons; both are valid per CCPA §1798.135).
        assert "Do Not Sell My Info" in src, (
            "F71 regression: LegalPage footer link text changed from "
            "the CCPA-required 'Do Not Sell My Info' wording."
        )

    def test_footer_includes_ccpa_micro_label(self) -> None:
        src = _get_legal_page_source()
        # The "CCPA" micro-label answers the "what's this link?"
        # question without competing with the link itself.
        assert re.search(r">\s*CCPA\s*<", src), (
            "F71 regression: LegalPage footer no longer has the CCPA "
            "micro-label next to the Do Not Sell link."
        )

    def test_footer_includes_other_legal_links(self) -> None:
        src = _get_legal_page_source()
        # The footer MUST also include Privacy / Terms / DPA / Security
        # so the legal context is obvious (CCPA isn't an afterthought).
        # The link labels appear inside <Link>{label}</Link> blocks;
        # whitespace may sit between > and the label, so use a
        # regex that tolerates that.
        for label in ("Privacy", "Terms", "DPA", "Security"):
            import re as _re

            assert _re.search(
                r">\s*" + _re.escape(label) + r"\s*<",
                src,
            ), (
                f"F71 regression: LegalPage footer missing the '{label}' link."
            )

    def test_footer_uses_dns_prefetch_false(self) -> None:
        src = _get_legal_page_source()
        # The Do Not Sell link MUST be marked prefetch={false}
        # so a Next.js router prefetch doesn't fire a GET on a
        # POST endpoint on every page load.
        # The link is wrapped in <Link prefetch={false} href="/api/v1/me/do-not-sell"
        # — assert the order matches.
        assert re.search(
            r"prefetch=\{false\}[^>]*href=\"/api/v1/me/do-not-sell\"|"
            r"href=\"/api/v1/me/do-not-sell\"[^>]*prefetch=\{false\}",
            src,
        ), (
            "F71 regression: LegalPage Do Not Sell link is missing "
            "prefetch={false}, so Next.js will fire a GET on a POST "
            "endpoint on every page load."
        )
