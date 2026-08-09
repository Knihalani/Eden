"""Clerk auth card contrast regression tests.

The original user-flagged bug: text appearing "black on black" on the
Clerk sign-in card, because Clerk's default ``colorPrimary``-tied
variables resolved to dark colours on our dark surface and several
``elements.*`` rules inherited the dark theme rather than overriding.

2026-07 refresh — the portal moved to the **Signal Black** design
system (``.impeccable.md``: pure-black surfaces, Signal Gold ``#E8B84A``
accent) and the Clerk theme was rewritten with it. Two structural
changes invalidated the old assertions, so they were rewritten rather
than deleted:

1. **Card chrome moved out of the appearance config.** ``elements.card``
   is now fully transparent/borderless; the real surface is the
   ``.auth-card`` rule in ``src/styles/components.css``. The
   opaque-background and visible-border guards were repointed there.
2. **Per-element colours are no longer the defence against dark-on-dark.**
   The theme sets ``variables.colorText``/``colorTextSecondary`` globally,
   so an element with no ``color`` inherits *white*, not Clerk's
   ``#212126``. Enumerating a hardcoded list of elements that must each
   declare a colour therefore guarded nothing real (and broke whenever an
   element was styled via ``variables`` instead).

So instead of a hardcoded token allowlist, these tests now **compute**
WCAG 2.1 contrast for every colour the theme actually declares, against
the surface that colour actually sits on. That is strictly stronger than
the old allowlist: it cannot be satisfied by a new-but-dark token, and it
adapts automatically when the palette is retuned.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_PORTAL_SRC = (
    Path(__file__).resolve().parents[3] / "clients" / "portal" / "src"
)

THEME_PATH = _PORTAL_SRC / "components" / "auth" / "clerk-theme.ts"
COMPONENTS_CSS_PATH = _PORTAL_SRC / "styles" / "components.css"

# The Clerk card renders on the pure-black auth surface
# (``.auth-card { background: var(--bg-elevated) }`` and
# ``--bg-elevated: var(--eden-black)``).
CARD_SURFACE = "#000000"

# WCAG 2.1 floors.
AA_NORMAL_TEXT = 4.5  # SC 1.4.3
NON_TEXT_CONTRAST = 3.0  # SC 1.4.11 — control boundaries


# ─────────────────────────────────────────────────────────────────────────────
# WCAG helpers
# ─────────────────────────────────────────────────────────────────────────────


def _rel_luminance(rgb: tuple[float, float, float]) -> float:
    """WCAG 2.1 relative luminance for an (r, g, b) triple in 0..255."""

    def adj(c: float) -> float:
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = rgb
    return 0.2126 * adj(r) + 0.7152 * adj(g) + 0.0722 * adj(b)


def _contrast_ratio(
    fg: tuple[float, float, float], bg: tuple[float, float, float]
) -> float:
    l1, l2 = _rel_luminance(fg), _rel_luminance(bg)
    lighter, darker = max(l1, l2), min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


def _parse_color(
    value: str, over: tuple[float, float, float]
) -> tuple[float, float, float] | None:
    """Parse a CSS colour literal into an (r, g, b) triple.

    ``rgba()`` values are alpha-composited over ``over`` so a faint white
    alpha on black is measured at its *rendered* lightness rather than as
    pure white. Returns ``None`` for values we can't resolve statically
    (``var(...)``, ``transparent``, ``inherit``, gradients) — those are
    skipped rather than guessed at.
    """
    value = value.strip().strip("\"'").strip()

    hex_m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", value)
    if hex_m:
        h = hex_m.group(1)
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]

    rgba_m = re.fullmatch(
        r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*"
        r"(?:,\s*([\d.]+)\s*)?\)",
        value,
    )
    if rgba_m:
        r, g, b = (float(rgba_m.group(i)) for i in (1, 2, 3))
        alpha = float(rgba_m.group(4)) if rgba_m.group(4) else 1.0
        return tuple(  # type: ignore[return-value]
            alpha * c + (1 - alpha) * o
            for c, o in zip((r, g, b), over, strict=True)
        )

    return None


BLACK = _parse_color(CARD_SURFACE, (0, 0, 0))
assert BLACK is not None


# ─────────────────────────────────────────────────────────────────────────────
# Source parsing
# ─────────────────────────────────────────────────────────────────────────────


def _strip_comments(source: str) -> str:
    """Strip ``// line`` and ``/* block */`` comments so the regexes don't
    pick up colour values mentioned in the explanatory prose."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    source = re.sub(r"//[^\n]*", "", source)
    source = _inline_constants(source)
    return source


def _inline_constants(source: str) -> str:
    """Substitute ``const NAME = "literal"`` values back into their use sites.

    The theme hoists shared values (e.g. ``CONTROL_BORDER``) into named
    constants. Without this the contrast checks would see a bare
    identifier, fail to parse it, and *skip* — silently turning the guard
    into a no-op. Resolving them keeps the check real.
    """
    constants = dict(
        re.findall(
            r'\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")\s*;',
            source,
        )
    )
    for name, literal in constants.items():
        source = re.sub(
            rf"(:\s*){re.escape(name)}\b", rf"\g<1>{literal}", source
        )
    return source


def _element_blocks(source: str) -> dict[str, str]:
    """Map every ``elements.<name>`` key to its full block body.

    Brace-matched rather than regex-delimited so nested state blocks
    (``"&:hover": { ... }``) stay attached to their parent — a hover
    colour has to clear AA too.
    """
    start = source.index("elements:")
    start = source.index("{", start)

    blocks: dict[str, str] = {}
    depth = 0
    i = start
    # Track the identifier immediately preceding each ``{`` at depth 1.
    while i < len(source):
        ch = source[i]
        if ch == "{":
            depth += 1
            if depth == 2:
                head = source[:i]
                name_m = re.search(r"([A-Za-z_][\w]*)\s*:\s*$", head)
                if name_m:
                    body_start = i + 1
                    inner = 1
                    j = body_start
                    while j < len(source) and inner:
                        if source[j] == "{":
                            inner += 1
                        elif source[j] == "}":
                            inner -= 1
                        j += 1
                    blocks[name_m.group(1)] = source[body_start : j - 1]
        elif ch == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    return blocks


# A style value: a quoted string (matched whole, so the commas inside
# ``rgba(255,255,255,0.38)`` don't truncate it) or a bare token.
_VALUE = r"(?:\"[^\"]*\"|'[^']*'|[^,\n}]+)"


def _declarations(body: str, prop: str) -> list[str]:
    """Every value assigned to ``prop`` in a block body, including inside
    nested state blocks."""
    return [
        m.group(1).strip()
        for m in re.finditer(rf"\b{re.escape(prop)}:\s*({_VALUE})", body)
    ]


@pytest.fixture(scope="module")
def theme_source() -> str:
    return THEME_PATH.read_text()


@pytest.fixture(scope="module")
def theme_clean(theme_source: str) -> str:
    return _strip_comments(theme_source)


@pytest.fixture(scope="module")
def elements(theme_clean: str) -> dict[str, str]:
    return _element_blocks(theme_clean)


def _element_surface(body: str) -> tuple[float, float, float]:
    """The background a block's text actually sits on: its own opaque
    ``backgroundColor`` if it declares one, else the black card."""
    for value in _declarations(body, "backgroundColor"):
        parsed = _parse_color(value, BLACK)
        if parsed is not None:
            return parsed
    return BLACK


# Build the parametrisation eagerly so each declared colour becomes its
# own test id — a failure names the exact element that went dark.
def _color_cases() -> list[tuple[str, str]]:
    try:
        src = _strip_comments(THEME_PATH.read_text())
    except OSError:  # pragma: no cover - covered by test_theme_file_exists
        return []
    cases: list[tuple[str, str]] = []
    for name, body in _element_blocks(src).items():
        for value in _declarations(body, "color"):
            cases.append((name, value))
    return cases


def _border_cases() -> list[tuple[str, str]]:
    try:
        src = _strip_comments(THEME_PATH.read_text())
    except OSError:  # pragma: no cover
        return []
    cases: list[tuple[str, str]] = []
    for name, body in _element_blocks(src).items():
        for value in _declarations(body, "borderColor"):
            cases.append((name, value))
    return cases


# ─────────────────────────────────────────────────────────────────────────────
# File-shape guards
# ─────────────────────────────────────────────────────────────────────────────


def test_theme_file_exists():
    assert THEME_PATH.exists(), f"Missing Clerk theme file: {THEME_PATH}"


def test_theme_exports_clerk_appearance(theme_source: str):
    assert "export { clerkAppearance }" in theme_source


# ─────────────────────────────────────────────────────────────────────────────
# Global variables — the primary defence against "black on black"
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "variable", ["colorText", "colorTextSecondary", "colorInputText"]
)
def test_theme_variables_set_light_body_text(theme_clean: str, variable: str):
    """Clerk defaults ``colorText`` to ``#212126``, which is invisible on
    our black card. The theme must override each body-text variable, and
    the override must clear AA on black — this is what stops unstyled
    Clerk sub-components (``select``, ``userPreview``, ``modalContent``,
    the whole UserProfile tree) rendering dark-on-dark, which is why the
    old per-element allowlist is no longer needed."""
    m = re.search(rf"\b{variable}:\s*({_VALUE})", theme_clean)
    assert m, f"Clerk theme does not set variables.{variable}"

    parsed = _parse_color(m.group(1), BLACK)
    assert parsed is not None, (
        f"variables.{variable} = {m.group(1)!r} could not be resolved to a "
        f"concrete colour; use a literal so contrast is statically checkable."
    )
    ratio = _contrast_ratio(parsed, BLACK)
    assert ratio >= AA_NORMAL_TEXT, (
        f"variables.{variable} is only {ratio:.2f}:1 on the black card "
        f"surface; WCAG AA normal text needs {AA_NORMAL_TEXT}:1. This is the "
        f'exact "black on black" regression this module exists to catch.'
    )


def test_theme_delegates_card_chrome(theme_clean: str, elements: dict[str, str]):
    """The card surface is owned by ``.auth-card`` (see
    ``test_auth_card_*`` below). Clerk's own card must stay transparent
    and borderless or we get a double edge / double radius."""
    assert "colorBackground: \"transparent\"" in theme_clean, (
        "Clerk variables.colorBackground must stay transparent — the "
        ".auth-card rule owns the surface."
    )
    card = elements.get("card")
    assert card is not None, "elements.card block not found"
    assert "transparent" in card, (
        "elements.card must keep a transparent background so .auth-card "
        "is the only surface."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Every declared colour must clear AA on the surface it sits on
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("element_name", "raw_value"),
    _color_cases(),
    ids=lambda v: v if isinstance(v, str) else str(v),
)
def test_declared_text_color_passes_aa(
    elements: dict[str, str], element_name: str, raw_value: str
):
    """Computed replacement for the old token allowlist.

    Every ``color`` the theme declares — including inside ``&:hover``
    state blocks — is measured against that element's own background
    (its ``backgroundColor`` if it sets one, else the black card). A
    dark colour on a dark surface fails here no matter which token or
    literal introduced it.
    """
    parsed = _parse_color(raw_value, BLACK)
    if parsed is None:
        pytest.skip(
            f"{element_name}.color = {raw_value!r} is not a static literal "
            f"(var()/transparent/inherit); contrast can't be computed here."
        )

    surface = _element_surface(elements[element_name])
    ratio = _contrast_ratio(parsed, surface)
    assert ratio >= AA_NORMAL_TEXT, (
        f"{element_name} sets color {raw_value!r}, only {ratio:.2f}:1 against "
        f"its background rgb{tuple(round(c) for c in surface)}. WCAG AA "
        f"normal text needs {AA_NORMAL_TEXT}:1."
    )


def test_primary_button_text_passes_aa_on_gold(elements: dict[str, str]):
    """The primary button is the one place dark text is correct.

    Signal Gold (``#E8B84A``) is a *light* fill, so black text on it
    scores 11.39:1 while white-on-gold is only 1.84:1 — nowhere near AA.
    This pins the direction of the choice, not just the ratio, so a
    well-meaning "make the button text white" change fails loudly.
    """
    body = elements.get("formButtonPrimary")
    assert body is not None, "formButtonPrimary block not found"

    fill_values = _declarations(body, "backgroundColor")
    assert fill_values, "formButtonPrimary has no backgroundColor"
    fill = _parse_color(fill_values[0], BLACK)
    assert fill is not None, "formButtonPrimary fill is not a static literal"

    color_values = _declarations(body, "color")
    assert color_values, "formButtonPrimary has no color declaration"
    text = _parse_color(color_values[0], fill)
    assert text is not None, "formButtonPrimary color is not a static literal"

    ratio = _contrast_ratio(text, fill)
    assert ratio >= AA_NORMAL_TEXT, (
        f"formButtonPrimary text is only {ratio:.2f}:1 on its fill; "
        f"needs {AA_NORMAL_TEXT}:1."
    )

    white_ratio = _contrast_ratio((255, 255, 255), fill)
    assert ratio > white_ratio, (
        "Dark text on the light gold button must outscore white-on-gold "
        f"({white_ratio:.2f}:1, fails AA). Keep the button text dark."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Control borders — WCAG SC 1.4.11 (non-text contrast)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("element_name", "raw_value"),
    _border_cases(),
    ids=lambda v: v if isinstance(v, str) else str(v),
)
def test_control_border_passes_non_text_contrast(
    elements: dict[str, str], element_name: str, raw_value: str
):
    """Inputs, OTP cells and social buttons are filled pure black on a
    pure-black card, so their border is the *only* thing that delimits
    the control. SC 1.4.11 and the ``.impeccable.md`` checklist ("Borders
    on text/inputs are >= 3:1 contrast on their background") both apply.

    The 2026-06 audit (commit d9cab1b3, "push every border to WCAG AA")
    deliberately raised these; the Signal Black rewrite dropped them back
    to a 0.14 white alpha (#232323, 1.34:1) by reusing the decorative
    hairline. This guard is what keeps that from happening silently —
    the doc's own wording is "do not regress".
    """
    parsed = _parse_color(raw_value, _element_surface(elements[element_name]))
    if parsed is None:
        pytest.skip(
            f"{element_name}.borderColor = {raw_value!r} is not a static "
            f"literal; contrast can't be computed here."
        )

    surface = _element_surface(elements[element_name])
    ratio = _contrast_ratio(parsed, surface)
    assert ratio >= NON_TEXT_CONTRAST, (
        f"{element_name} border {raw_value!r} renders at only {ratio:.2f}:1 "
        f"on its own fill — below the {NON_TEXT_CONTRAST}:1 non-text floor. "
        f"The control's edge is effectively invisible."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Card chrome — moved from elements.card to the .auth-card CSS rule
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def auth_card_rule() -> str:
    """The ``.auth-card`` block from ``components.css``.

    Repointed here from ``elements.card``: the Signal Black rewrite moved
    the card surface out of the Clerk appearance object (which now
    neutralises Clerk's chrome entirely) into a real CSS rule.
    """
    css = _strip_comments(COMPONENTS_CSS_PATH.read_text())
    m = re.search(r"\.auth-card\s*\{(?P<body>[^}]*)\}", css)
    assert m, f".auth-card rule not found in {COMPONENTS_CSS_PATH}"
    return m.group("body")


def test_auth_card_background_is_fully_opaque(auth_card_rule: str):
    """A semi-transparent card lets the brand panel behind it bleed
    through and washes out the card edge (the original June 22 bug, when
    it was ``rgba(15, 20, 25, 0.85)``). The surface must be opaque."""
    m = re.search(r"background:\s*([^;]+);", auth_card_rule)
    assert m, ".auth-card has no background declaration"
    value = m.group(1).strip()

    rgba_alpha = re.search(r"rgba\([^)]+,\s*([0-9.]+)\s*\)", value)
    if rgba_alpha:
        alpha = float(rgba_alpha.group(1))
        assert alpha >= 0.99, (
            f".auth-card background is semi-transparent (alpha={alpha}); the "
            f"brand panel behind it leaks through and washes the card edge out."
        )
    assert value.startswith("var(") or value.startswith("#"), (
        f".auth-card background should resolve to a defined surface token, "
        f"got {value!r}"
    )


def test_auth_card_border_uses_visible_token(auth_card_rule: str):
    """The card edge separates the form column from the brand panel, so
    it must be a deliberate border token rather than the default hairline.

    (Was ``--border-glow`` under the old blue palette; Signal Black uses
    the ``--line-strong`` step. Assert on the *strong* step generally so
    a downgrade to plain ``--line`` fails.)
    """
    m = re.search(r"border:\s*([^;]+);", auth_card_rule)
    assert m, ".auth-card has no border declaration"
    value = m.group(1).strip()
    assert "strong" in value or "glow" in value or "accent" in value, (
        f".auth-card border should use a strengthened border token "
        f"(--line-strong / --border-glow / --line-accent) so the card edge "
        f"reads against the brand panel, got {value!r}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Palette spot-checks (pure math — no source parsing)
# ─────────────────────────────────────────────────────────────────────────────


# Signal Black palette (see .impeccable.md). Replaces the pre-2026-07
# blue-accent set (#5B9EFF accent on #0F1419) that this module used to pin.
TOKENS_HEX = {
    "text-primary": "#FFFFFF",
    "text-secondary": "#A1A1AA",
    "text-tertiary": "#D4D4D8",
    "text-faint": "#8B8B96",
    "accent-gold": "#E8B84A",
    "success": "#4ECF96",
    "danger": "#EF4444",
}


@pytest.mark.parametrize("fg_token", sorted(TOKENS_HEX))
def test_text_token_contrast_on_card_bg(fg_token: str):
    """Every text token used inside the auth card must hit WCAG AA
    (>=4.5:1) against the pure-black card surface."""
    fg = _parse_color(TOKENS_HEX[fg_token], BLACK)
    assert fg is not None
    ratio = _contrast_ratio(fg, BLACK)
    assert ratio >= AA_NORMAL_TEXT, (
        f"{fg_token} on the black card is only {ratio:.2f}:1; "
        f"below WCAG AA's {AA_NORMAL_TEXT}:1 normal-text floor."
    )


def test_gold_button_prefers_dark_text():
    """Locks the design choice: Signal Gold is a light fill, so it takes
    dark text (11.39:1), never white (1.84:1 — fails AA outright)."""
    gold = _parse_color(TOKENS_HEX["accent-gold"], BLACK)
    assert gold is not None
    dark_ratio = _contrast_ratio((0, 0, 0), gold)
    white_ratio = _contrast_ratio((255, 255, 255), gold)
    assert dark_ratio >= AA_NORMAL_TEXT, (
        f"Black on Signal Gold should be >={AA_NORMAL_TEXT}:1, "
        f"got {dark_ratio:.2f}:1"
    )
    assert dark_ratio > white_ratio, (
        "Dark text on the gold button must outscore white-on-gold "
        f"({white_ratio:.2f}:1)"
    )
