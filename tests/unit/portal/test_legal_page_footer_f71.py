"""F71 — Marketing footer with CCPA "Do Not Sell" link.

Per the prod-ready checklist §1.5: every marketing page MUST surface the
"Do Not Sell My Personal Information" link so California residents can
find the opt-out disclosure. Pre-F71 the link was only on the marketing
homepage footer; the legal pages (/privacy, /terms, /dpa, /security)
used a ``LegalPage`` shell that had no footer at all.

2026-07 refresh — the portal marketing refactor deleted
``components/layout/legal-page.tsx`` entirely. The invariant did NOT go
away, it moved up a level and got *stronger*: legal pages are now plain
routes under the ``(marketing)`` route group, and
``app/(marketing)/layout.tsx`` renders the shared ``MarketingFooter``
around all of them. So rather than pinning one shell component, these
tests pin the two things that actually make the guarantee hold:

1. the ``(marketing)`` layout wraps every page in ``MarketingFooter``, and
2. ``MarketingFooter`` carries the CCPA link and the legal link set.

That covers strictly more pages than the old ``LegalPage`` guard did
(the whole marketing surface, not just the four legal docs).

One assertion was retired rather than repointed — see
``test_do_not_sell_page_states_the_non_sale_disclosure`` for why the
POST-form check no longer applies.
"""

from __future__ import annotations

import re
from pathlib import Path

_PORTAL_SRC = (
    Path(__file__).resolve().parents[3] / "clients" / "portal" / "src"
)

_MARKETING_APP = _PORTAL_SRC / "app" / "(marketing)"
_FOOTER_PATH = _PORTAL_SRC / "components" / "marketing" / "marketing-footer.tsx"
_MARKETING_LAYOUT_PATH = _MARKETING_APP / "layout.tsx"

# The legal docs that must inherit the footer.
_LEGAL_ROUTES = ("privacy", "terms", "dpa", "security")


def _footer_source() -> str:
    return _FOOTER_PATH.read_text()


def _layout_source() -> str:
    return _MARKETING_LAYOUT_PATH.read_text()


class TestF71LegalPageFooter:
    """Every marketing/legal page MUST render a footer carrying the
    CCPA "Do Not Sell" link."""

    def test_legal_pages_live_in_the_marketing_group(self) -> None:
        """The footer guarantee is delivered by the ``(marketing)`` route
        group layout, so the legal docs have to actually live inside it."""
        for route in _LEGAL_ROUTES:
            assert (_MARKETING_APP / route / "page.tsx").exists(), (
                f"F71 regression: /{route} is no longer a page under the "
                f"(marketing) route group, so it no longer inherits the "
                f"MarketingFooter and its CCPA link."
            )

    def test_marketing_layout_renders_the_shared_footer(self) -> None:
        """Replaces the old "LegalPage renders a <footer>" check: the
        footer now comes from the route-group layout, which is what makes
        it impossible for a new legal page to ship without one."""
        src = _layout_source()
        assert "MarketingFooter" in src, (
            "F71 regression: app/(marketing)/layout.tsx no longer renders "
            "MarketingFooter — legal pages would ship with no footer and "
            "no CCPA link."
        )
        assert re.search(r"<MarketingFooter\s*/>", src), (
            "F71 regression: MarketingFooter is imported but not rendered "
            "in the (marketing) layout."
        )

    def test_footer_renders_a_footer_element(self) -> None:
        src = _footer_source()
        assert "<footer" in src, (
            "F71 regression: MarketingFooter no longer renders a <footer> "
            "element. Per the prod-ready checklist §1.5, every marketing "
            "page must have a footer with the CCPA Do Not Sell link."
        )

    def test_footer_includes_do_not_sell_link(self) -> None:
        src = _footer_source()
        # Links are declared as data (``{ href, label }``) and rendered
        # through a shared <Link>, so assert on the declaration rather
        # than on a literal ``href="..."`` attribute.
        assert re.search(r'href:\s*"/do-not-sell"', src), (
            "F71 regression: MarketingFooter no longer includes the CCPA "
            "Do Not Sell link (pointing at the /do-not-sell page)."
        )
        # The link text MUST state the consumer right on its face. CCPA
        # §1798.135 titles the link "Do Not Sell My Personal Information";
        # the UI uses the shorter "Do Not Sell My Info" for line length,
        # which is accepted practice. A bare "Do Not Sell" is NOT — it
        # reads as a category header rather than an action.
        assert "Do Not Sell My Info" in src, (
            "F71 regression: the CCPA link text was shortened. It must keep "
            "the 'Do Not Sell My Info' wording so the link states the right "
            "being exercised."
        )

    def test_do_not_sell_link_is_grouped_under_a_legal_heading(self) -> None:
        """Replaces the old free-floating "CCPA" micro-label, which the
        refactor dropped along with ``LegalPage``. The label existed to
        answer "what is this link?"; a titled **Legal** column does that
        job better, so pin the grouping instead of the old label."""
        src = _footer_source()
        assert re.search(r'title:\s*"Legal"', src), (
            "F71 regression: the footer no longer groups the CCPA and legal "
            "links under a titled 'Legal' column, so the Do Not Sell link "
            "loses the context that told users what it is."
        )
        m = re.search(
            r"LEGAL_LINKS[^=]*=\s*\[(?P<body>.*?)\]", src, re.DOTALL
        )
        assert m, "F71 regression: LEGAL_LINKS block not found in the footer."
        assert "/do-not-sell" in m.group("body"), (
            "F71 regression: the Do Not Sell link was moved out of the "
            "LEGAL_LINKS group."
        )

    def test_footer_includes_other_legal_links(self) -> None:
        # The footer MUST also surface Privacy / Terms / DPA / Security so
        # the legal context is obvious (CCPA isn't an afterthought).
        # Security sits in the Resources column, the rest in Legal — this
        # asserts presence, not placement.
        src = _footer_source()
        for label in ("Privacy", "Terms", "DPA", "Security"):
            assert re.search(rf'label:\s*"{re.escape(label)}"', src), (
                f"F71 regression: MarketingFooter missing the '{label}' link."
            )
            expected_href = f"/{label.lower()}"
            assert re.search(rf'href:\s*"{re.escape(expected_href)}"', src), (
                f"F71 regression: the '{label}' footer link no longer points "
                f"at {expected_href}."
            )

    def test_do_not_sell_page_states_the_non_sale_disclosure(self) -> None:
        """The /do-not-sell destination must exist and must actually make
        the CCPA disclosure.

        Retired assertion: this used to require a client island
        (``do-not-sell-form.tsx``) POSTing to ``/api/v1/me/do-not-sell``.
        That form was removed in ``9a1452b4`` ("complete live API wire-up")
        and there is no ``/api/v1/me/do-not-sell`` handler anywhere in the
        backend — re-adding the form would post into a void, which is worse
        than no form. Under CCPA a business that does not sell personal
        information satisfies the requirement with a clear statement to
        that effect, so the static disclosure page is the correct surface.
        What still matters, and is pinned here, is that the link resolves
        to a real page that makes the statement.
        """
        page = _MARKETING_APP / "do-not-sell" / "page.tsx"
        assert page.exists(), (
            "F71 regression: the /do-not-sell route is gone, so the CCPA "
            "footer link is a dead link."
        )
        src = page.read_text()
        assert re.search(r"does not sell personal information", src, re.I), (
            "F71 regression: /do-not-sell no longer carries the explicit "
            "non-sale disclosure. Under CCPA that statement is what "
            "discharges the obligation now that the opt-out form is gone — "
            "if Eden starts selling data this page needs a real mechanism "
            "again, not just softened wording."
        )
