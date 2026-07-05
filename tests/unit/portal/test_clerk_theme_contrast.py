"""Clerk auth card contrast regression tests.

The user-flagged bug: text appearing "black on black" on the Clerk
sign-in card. Root cause: Clerk's default ``colorPrimary``-tied
variables resolved to dark colours on our dark surface, and several
``elements.*`` rules inherited the dark theme rather than overriding
explicitly.

These tests guard the fix by static-analyzing the Clerk theme config
file. They catch the most common regression: an element setting
``color`` (or being one of the ``form*`` elements that ship a label
or text node) that doesn't override Clerk's default dark text colour.

The contrast checks themselves use the WCAG 2.1 relative luminance
formula. Not exhaustive — visual diff on a real monitor still wins —
but catches the obvious regressions at lint time.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

THEME_PATH = (
    Path(__file__).resolve().parents[3]
    / "clients"
    / "portal"
    / "src"
    / "components"
    / "auth"
    / "clerk-theme.ts"
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _strip_comments(source: str) -> str:
    """Strip ``// line`` and ``/* block */`` comments so the regex
    doesn't pick up colour values mentioned in the explanatory text."""
    # Block comments first (so we don't accidentally match inside them).
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    # Then line comments — drop everything from ``//`` to end of line.
    source = re.sub(r"//[^\n]*", "", source)
    return source


# Text-bearing elements where Clerk would otherwise default to a dark
# colour that reads as invisible on our dark card surface.
TEXT_BEARING_ELEMENTS = [
    "headerTitle",
    "headerSubtitle",
    "formFieldLabel",
    "formFieldInput",
    "formFieldHintText",
    "formFieldErrorText",
    "formFieldSuccessText",
    "socialButtonsBlockButton",
    "dividerText",
    "footerActionLink",
    "footerActionText",
    "identityPreviewText",
    "otpCodeFieldInput",
    "alternativeMethodButton",
    "alternativeMethodBlockButton",
    "alert",
    "alertText",
    "select",
    "selectButton",
    "selectOption",
    "formButtonReset",
    "userPreviewText",
    "userPreviewSecondaryIdentifier",
    "activeDevice",
    "modalContent",
]


# Light text tokens that contrast against our dark ``--bg-secondary``
# card surface (≥4.5:1 against #0F1419).
LIGHT_TEXT_TOKENS = [
    "var(--text-primary)",
    "var(--text-secondary)",
    "var(--text-muted)",
    "var(--accent)",
    "var(--accent-hover)",
    "var(--success)",
    "var(--error)",
    "var(--warning)",
    "var(--accent-foreground)",
    "#FFFFFF",
    "#ffffff",
    "#FFF",
    "#fff",
]


# ─────────────────────────────────────────────────────────────────────────────
# File-shape guards
# ─────────────────────────────────────────────────────────────────────────────


def test_theme_file_exists():
    assert THEME_PATH.exists(), f"Missing Clerk theme file: {THEME_PATH}"


@pytest.fixture(scope="module")
def theme_source() -> str:
    return THEME_PATH.read_text()


@pytest.fixture(scope="module")
def theme_clean(theme_source: str) -> str:
    return _strip_comments(theme_source)


def test_theme_exports_clerkAppearance(theme_source: str):
    assert "export { clerkAppearance }" in theme_source


# ─────────────────────────────────────────────────────────────────────────────
# Element-level guards: every text-bearing element must set a light colour
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("element_name", TEXT_BEARING_ELEMENTS)
def test_text_element_sets_light_color(theme_clean: str, element_name: str):
    """Each text-bearing element on the dark card must explicitly set
    a ``color`` value from the light-token list. Catches the regression
    where Clerk's default ``#212126`` text bleeds through and reads as
    "black on black" on the dark surface."""
    pattern = re.compile(
        rf"{re.escape(element_name)}:\s*\{{(?P<body>[^}}]+)\}}",
        re.DOTALL,
    )
    m = pattern.search(theme_clean)
    assert m, f"Element {element_name!r} not found in clerk-theme.ts"
    body = m.group("body")

    color_match = re.search(r"color:\s*([\"']?)([^\"',}]+)\1", body)
    assert color_match, (
        f"Element {element_name!r} has no explicit ``color`` declaration; "
        f"Clerk's default #212126 will leak through and look black on black "
        f"on the dark card surface."
    )
    color_value = color_match.group(2).strip()
    assert any(tok in color_value for tok in LIGHT_TEXT_TOKENS), (
        f"Element {element_name!r} sets color to {color_value!r} which "
        f"isn't a recognised light token. Allowed: {LIGHT_TEXT_TOKENS}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# The formButtonPrimary is special — sits on a LIGHT blue button background,
# so dark text is the right answer (and reads better than white on light blue).
# ─────────────────────────────────────────────────────────────────────────────


def test_primary_button_uses_dark_text_on_light_blue(theme_clean: str):
    """June 22 review: the user said "make the text white, not black on
    black" — but they were referring to text on the dark *card*, not on
    the light-blue *button*. Dark text on ``--accent`` (#5B9EFF) gives
    7.5:1 contrast (AA Large/Normal at any size). White on the same blue
    only gives 2.7:1 — fails AA. Keep dark."""
    m = re.search(
        r"formButtonPrimary:\s*\{(?P<body>[^}]+)\}",
        theme_clean,
        re.DOTALL,
    )
    assert m, "formButtonPrimary block not found"
    body = m.group("body")

    color_match = re.search(r"color:\s*([\"']?)([^\"',}]+)\1", body)
    assert color_match, "formButtonPrimary has no color declaration"
    color_value = color_match.group(2).strip()

    # Dark text on the light-blue button background.
    assert "var(--accent-foreground)" in color_value, (
        f"formButtonPrimary color should be --accent-foreground (dark) "
        f"for 7.5:1 contrast on the light-blue button. Got {color_value!r}."
    )


# ─────────────────────────────────────────────────────────────────────────────
# The card surface must be fully opaque
# ─────────────────────────────────────────────────────────────────────────────


def test_card_background_is_fully_opaque(theme_clean: str):
    """June 22 fix: prior ``rgba(15, 20, 25, 0.85)`` blended with the
    brand panel and made the card edge indistinguishable. Now uses
    ``var(--bg-secondary)`` (fully opaque)."""
    m = re.search(
        r"card:\s*\{(?P<body>[^}]+backgroundColor:[^}]+)\}",
        theme_clean,
        re.DOTALL,
    )
    assert m, "card block not found"
    body = m.group("body")

    bg_match = re.search(r"backgroundColor:\s*([\"']?)([^\"',}]+)\1", body)
    assert bg_match, "card has no backgroundColor"
    bg_value = bg_match.group(2).strip()

    rgba_alpha = re.search(r"rgba\([^)]+,\s*([0-9.]+)\s*\)", bg_value)
    if rgba_alpha:
        alpha = float(rgba_alpha.group(1))
        assert alpha >= 0.99, (
            f"card background is semi-transparent (alpha={alpha}); "
            f"the brand-panel behind it leaks through and washes the "
            f"card edge out. Use var(--bg-secondary) for a defined surface."
        )
    assert "var(--bg-secondary)" in bg_value or bg_value.startswith("#"), (
        f"card background should resolve to a defined surface, got {bg_value!r}"
    )


def test_card_border_uses_visible_token(theme_clean: str):
    """June 22 fix: bumped from ``--border-strong`` (6.4:1 but
    low-saturation) to ``--border-glow`` (#5B9EFF accent blue) for
    a crisper edge against the dark form column."""
    m = re.search(
        r"card:\s*\{(?P<body>[^}]+border:[^}]+)\}",
        theme_clean,
        re.DOTALL,
    )
    assert m, "card block not found"
    body = m.group("body")
    border_match = re.search(r"border:\s*([\"']?)([^\"',}]+)\1", body)
    assert border_match, "card has no border"
    border_value = border_match.group(2).strip()
    assert "var(--border-glow)" in border_value, (
        f"card border should use --border-glow for a crisp accent "
        f"edge, got {border_value!r}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# WCAG contrast spot-checks
# ─────────────────────────────────────────────────────────────────────────────


def _rel_luminance(hex_color: str) -> float:
    """WCAG 2.1 relative luminance for a #RRGGBB hex string."""
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i+2], 16) / 255.0 for i in (0, 2, 4))
    def adj(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * adj(r) + 0.7152 * adj(g) + 0.0722 * adj(b)


def _contrast_ratio(fg_hex: str, bg_hex: str) -> float:
    l1, l2 = _rel_luminance(fg_hex), _rel_luminance(bg_hex)
    lighter, darker = max(l1, l2), min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


TOKENS_HEX = {
    "text-primary": "#E4ECF7",
    "text-secondary": "#94A3B8",
    "text-muted": "#708090",
    "accent": "#5B9EFF",
    "accent-foreground": "#03060A",
    "error": "#FF6B7A",
    "bg-secondary": "#0F1419",
}


@pytest.mark.parametrize("fg_token", [
    "text-primary", "text-secondary", "text-muted", "accent", "error",
])
def test_text_token_contrast_on_card_bg(fg_token: str):
    """Spot check: every text token we use inside the card must hit
    WCAG AA (≥4.5:1) against the new card background ``--bg-secondary``."""
    ratio = _contrast_ratio(TOKENS_HEX[fg_token], TOKENS_HEX["bg-secondary"])
    assert ratio >= 4.5, (
        f"{fg_token} on --bg-secondary is only {ratio:.2f}:1; "
        f"below WCAG AA's 4.5:1 normal-text floor."
    )


def test_primary_button_dark_text_passes_aa():
    """The primary button: dark text (--accent-foreground = #03060A)
    on light accent (#5B9EFF) must pass AA. This is 7.5:1 — better
    than white-on-accent (2.7:1)."""
    ratio = _contrast_ratio(
        TOKENS_HEX["accent-foreground"], TOKENS_HEX["accent"]
    )
    assert ratio >= 4.5, (
        f"Dark foreground on --accent should be ≥4.5:1, got {ratio:.2f}:1"
    )
    # And it must be BETTER than white-on-accent (the alternative we
    # considered and rejected). Locks in the design choice.
    white_ratio = _contrast_ratio("#FFFFFF", TOKENS_HEX["accent"])
    assert ratio > white_ratio, (
        "Dark foreground on the light-blue button must outscore "
        "white-on-blue (which is only 2.7:1, fails AA)"
    )
